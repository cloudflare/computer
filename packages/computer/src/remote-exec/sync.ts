/**
 * The workspace side of push and pull.
 */
import { isNotFound, join, sameBytes, sha256, type SyncFs } from "./fs";
import { isRelPath, type Entry, type Report, type Skipped } from "./messages";
import type { SessionClient } from "./session";
import { RemoteExecError } from "./session";
import { linkStaysInside, Selector, walkWorkspace } from "./walk";

export const CHUNK_BYTES = 1024 * 1024;
/** How many files push reads and hashes at once. */
const HASH_CONCURRENCY = 8;

export interface SyncLimits {
  maxFileBytes: number;
  maxSyncBytes: number;
  maxSyncFiles: number;
}

export const DEFAULT_LIMITS: SyncLimits = {
  maxFileBytes: 32 * 1024 * 1024,
  maxSyncBytes: 512 * 1024 * 1024,
  maxSyncFiles: 50_000,
};

export interface SyncReport {
  status: "done" | "skipped";
  files: number;
  transferred: number;
  bytes: number;
  deleted: string[];
  deletedCount: number;
  skipped: Skipped[];
  skippedCount: number;
  conflicts: string[];
  lockWaitMs: number;
}

const REPORTED = 100;

export function skippedReport(lockWaitMs = 0): SyncReport {
  return {
    status: "skipped",
    files: 0,
    transferred: 0,
    bytes: 0,
    deleted: [],
    deletedCount: 0,
    skipped: [],
    skippedCount: 0,
    conflicts: [],
    lockWaitMs,
  };
}

function report(
  files: number,
  remote: Report,
  skipped: Skipped[],
  conflicts: string[],
  lockWaitMs: number,
): SyncReport {
  const allSkipped = [...skipped, ...remote.skipped];
  return {
    status: "done",
    files,
    transferred: remote.written,
    bytes: remote.bytes,
    deleted: remote.deleted.slice(0, REPORTED),
    deletedCount: remote.deleted.length,
    skipped: allSkipped.slice(0, REPORTED),
    skippedCount: allSkipped.length,
    conflicts: conflicts.slice(0, REPORTED),
    lockWaitMs,
  };
}

export interface Pushed {
  report: SyncReport;
  /** Hashes of what the workspace held at push time, to detect conflicts at pull. */
  hashes: Map<string, Uint8Array>;
}

/** Build the manifest for `globs`, send it, and stream the files the session wants. */
export async function push(
  session: SessionClient,
  fs: SyncFs,
  workspaceRoot: string,
  containerRoot: string,
  globs: string[],
  owner: string,
  limits: SyncLimits,
  lockWaitMs: number,
): Promise<Pushed> {
  const walked = await walkWorkspace(fs, workspaceRoot, new Selector(globs));
  const skipped: Skipped[] = [...walked.skipped];
  const manifest: Entry[] = [];
  let total = 0;
  for (const found of walked.found) {
    if (manifest.length >= limits.maxSyncFiles) {
      skipped.push({ path: found.rel, reason: "too-many-files" });
      continue;
    }
    if (
      found.kind === "file" &&
      (found.size > limits.maxFileBytes || total + found.size > limits.maxSyncBytes)
    ) {
      skipped.push({ path: found.rel, reason: "too-large" });
      continue;
    }
    total += found.size;
    manifest.push({
      path: found.rel,
      kind: found.kind,
      mode: found.mode,
      size: found.size,
      hash: new Uint8Array(),
      target: found.target,
    });
  }
  const files = manifest.filter((e) => e.kind === "file");
  let next = 0;
  const hashFiles = async () => {
    for (let entry = files[next++]; entry !== undefined; entry = files[next++]) {
      entry.hash = await sha256(await fs.readFile(join(workspaceRoot, entry.path)));
    }
  };
  await Promise.all(Array.from({ length: HASH_CONCURRENCY }, hashFiles));
  const hashes = new Map(files.map((e) => [e.path, e.hash]));
  const remote = await session.exclusive(async () => {
    await session.send({
      type: "push",
      selection: { root: containerRoot, globs },
      manifest,
      owner,
      // Still in the workspace, just not sent: the session's ledger would otherwise read their
      // absence from the manifest as a deletion. A path the protocol can't carry can't be in the
      // ledger either.
      keep: skipped.map((s) => s.path).filter(isRelPath),
    });
    const { indices } = await session.expect("want");
    for (const index of indices) {
      const entry = manifest[index];
      if (entry === undefined)
        throw new RemoteExecError(
          "protocol",
          `the session wanted entry ${index}, which doesn't exist`,
        );
      if (entry.kind !== "file") continue;
      let sent = false;
      const stream = await fs.readFile(join(workspaceRoot, entry.path));
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const flush = async (last: boolean) => {
        const data =
          pending.length === 1 && pending[0] ? pending[0] : concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        await session.send({ type: "chunk", index, data, last });
        sent = true;
      };
      for await (const piece of stream) {
        let offset = 0;
        while (offset < piece.byteLength) {
          const take = Math.min(piece.byteLength - offset, CHUNK_BYTES - pendingBytes);
          pending.push(piece.subarray(offset, offset + take));
          pendingBytes += take;
          offset += take;
          if (pendingBytes === CHUNK_BYTES) await flush(false);
        }
      }
      if (pendingBytes > 0 || !sent) await flush(true);
      else await session.send({ type: "chunk", index, data: new Uint8Array(), last: true });
    }
    await session.send({ type: "pushEnd" });
    return (await session.expect("pushReport")).report;
  });
  return { report: report(manifest.length, remote, skipped, [], lockWaitMs), hashes };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function currentHash(fs: SyncFs, path: string): Promise<Uint8Array | undefined> {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isFile) return undefined;
    return await sha256(await fs.readFile(path));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function ensureParent(fs: SyncFs, path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent) await fs.mkdir(parent, { recursive: true });
}

export async function pull(
  session: SessionClient,
  fs: SyncFs,
  workspaceRoot: string,
  pushedHashes: Map<string, Uint8Array>,
  limits: SyncLimits,
  lockWaitMs: number,
): Promise<SyncReport> {
  return session.exclusive(async () => {
    await session.send({ type: "pull" });
    const changes = await session.expect("changes");
    const skipped: Skipped[] = [...changes.skipped];
    const conflicts: string[] = [];
    let total = 0;
    let written = 0;
    for (const [index, entry] of changes.changed.entries()) {
      if (!isRelPath(entry.path)) throw new RemoteExecError("protocol", "unsafe path in changes");
      const dest = join(workspaceRoot, entry.path);
      const before = pushedHashes.get(entry.path);
      if (before !== undefined) {
        const now = await currentHash(fs, dest);
        if (now !== undefined && !sameBytes(now, before)) conflicts.push(entry.path);
      }
      // The same limits push() applies: a command can make links that point anywhere, and any
      // number of files.
      if (entry.kind === "symlink") {
        if (!linkStaysInside(entry.path, entry.target)) {
          skipped.push({ path: entry.path, reason: "symlink-escape" });
          continue;
        }
        if (written >= limits.maxSyncFiles) {
          skipped.push({ path: entry.path, reason: "too-many-files" });
          continue;
        }
        await ensureParent(fs, dest);
        await fs.rm(dest, { force: true });
        await fs.symlink(entry.target, dest);
        written++;
        continue;
      }
      // A file's chunks arrive in order, each one after the previous file's last.
      const tooMany = written >= limits.maxSyncFiles;
      const tooLarge =
        !tooMany && (entry.size > limits.maxFileBytes || total + entry.size > limits.maxSyncBytes);
      const tmp = `${dest}.remote-exec-${crypto.randomUUID().slice(0, 8)}.tmp`;
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      let writing: Promise<void> | undefined;
      if (!tooMany && !tooLarge) {
        await ensureParent(fs, dest);
        writing = fs.writeFile(tmp, readable, { mode: entry.mode });
        // A write that fails before reading would leave writer.write() below waiting for ever.
        writing.catch((error: unknown) => writer.abort(error).catch(() => undefined));
      }
      let received = 0;
      try {
        for (;;) {
          const chunk = await session.expect("chunk");
          if (chunk.index !== index)
            throw new RemoteExecError(
              "protocol",
              `chunk for entry ${chunk.index}, expected ${index}`,
            );
          received += chunk.data.byteLength;
          // The limits were checked against the announced size, so they hold for what's written
          // only if no more than that arrives.
          if (received > entry.size)
            throw new RemoteExecError("protocol", `${entry.path} is larger than announced`);
          if (writing !== undefined) await writer.write(chunk.data);
          if (chunk.last) break;
        }
        if (writing === undefined) {
          skipped.push({ path: entry.path, reason: tooMany ? "too-many-files" : "too-large" });
          continue;
        }
        await writer.close();
        await writing;
        await fs.rename(tmp, dest);
      } catch (error) {
        // Don't leave a partial temp file in the workspace.
        if (writing !== undefined) {
          await writer.abort(error).catch(() => undefined);
          await writing.catch(() => undefined);
          await fs.rm(tmp, { force: true }).catch(() => undefined);
        }
        throw error;
      }
      total += received;
      written++;
    }
    for (const path of changes.deleted) {
      await fs.rm(join(workspaceRoot, path), { force: true });
    }
    const end = await session.expect("pullEnd");
    const remote: Report = { ...end.report, written, bytes: total, deleted: changes.deleted };
    return report(changes.changed.length, remote, skipped, conflicts, lockWaitMs);
  });
}
