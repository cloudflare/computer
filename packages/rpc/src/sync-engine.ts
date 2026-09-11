// Restartable sync engine.
//
// One `next()` performs at most one complete block: plan it, transfer
// it, apply it, persist the cursor, yield. Nothing live crosses a
// yield boundary — every RPC stream is drained and disposed before the
// value is handed to the caller — because the caller may not come back.
// A Durable Object can be evicted between two `next()` calls, and the
// iterator object does not survive that. The operation row and the
// watermark do.
//
// The engine therefore never treats the iterator as state. Each step
// re-reads the durable cursor and the durable operation, which is what
// makes `pullBlocks(...)` and a freshly constructed `pullBlocks(...)`
// interchangeable.
//
// This module owns no timer and no alarm. The application decides when
// to call `next()`, from a request, an alarm, a queue, or a Workflow.

import {
  applyChanges,
  type BlockProfile,
  type ChangeCursor,
  type ChangeEntry,
  clearBlockMarker,
  compareChangeCursors,
  completeOperation,
  type Database,
  DEFAULT_BLOCK_PROFILE,
  fixTarget,
  hasObjects,
  markBlockStarted,
  openOperation,
  pruneSkips,
  readFetchCursor,
  readOperation,
  recordSkip,
  type SyncDirection,
  type SyncMode,
  shrinkBlockProfile,
  stageBlob,
  writeFetchCursor,
} from "@cloudflare/dofs";

import type { SyncRPC } from "./interface.js";

export interface SyncProgress {
  readonly operationId: string;
  readonly generation: string;
  readonly backend: string;
  readonly direction: SyncDirection;
  readonly mode: SyncMode;
  readonly cursor: ChangeCursor;
  readonly targetCursor: ChangeCursor;
  readonly entries: number;
  readonly bytes: number;
  // Entries the receiver deliberately refused, most often a read-only
  // mount conflict. Also written to the durable skip log.
  readonly skipped: number;
  readonly complete: boolean;
}

export interface PullBlocksOptions {
  readonly backend?: string;
  readonly ignore?: string[];
  // Internal sizing override. Not exposed on the public Workspace
  // surface; present so tests can force multi-block runs without
  // materialising thousands of files.
  readonly profile?: BlockProfile;
  readonly now?: () => number;
}

const DEFAULT_BACKEND = "default";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function maybeDispose(value: unknown): void {
  const d = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  if (typeof d === "function") d.call(value);
}

function entryCursor(entry: ChangeEntry): ChangeCursor {
  return { rev: entry.rev, path: entry.path };
}

// In-isolate join table. Two iterators in the same isolate driving the
// same backend and direction share one in-flight block instead of
// duplicating the transfer. This is an optimization only: after an
// eviction the map is empty and the durable operation row is what
// makes the next iterator correct.
const active = new Map<string, { generation: string; settled: Promise<SyncProgress> }>();

function activeKey(backend: string, direction: SyncDirection): string {
  return `${backend}:${direction}`;
}

// Drive one pull block to completion, or throw.
//
// Ordering is the whole safety argument: metadata is applied before the
// cursor moves, and the cursor never moves past an entry that has not
// been applied or deliberately recorded as skipped. A crash anywhere
// before the cursor write replays the block, which the receiver
// absorbs because staged objects and applied entries are idempotent.
async function runPullBlock(
  db: Database,
  remote: SyncRPC,
  backend: string,
  options: PullBlocksOptions,
): Promise<SyncProgress> {
  const now = options.now ?? (() => Date.now());
  const profile = options.profile ?? DEFAULT_BLOCK_PROFILE;

  // 1. Read or create the operation. A pending row is joined, so
  //    concurrent callers converge on one fixed target.
  const opened = openOperation(db, backend, "pull", now());
  let operation = opened.operation;

  if (operation.status === "capturing") {
    // Two-phase target capture: the remote settle call cannot join a
    // local transaction, so the target is read here and committed
    // conditionally. An eviction in between leaves a capturing row
    // that the next iterator takes over.
    pruneSkips(db, backend, "pull", operation.generation);
    // The pull target is the source's change head, not its own inbound
    // fetch cursor: we are pulling everything the source has produced.
    // A settled read also flushes writes still buffered in the shim,
    // so the target covers them instead of stranding them until the
    // next operation.
    const settled = await remote.watermarks({ settle: true });
    const promoted = fixTarget(
      db,
      backend,
      "pull",
      operation.generation,
      { target: { rev: settled.currentRev, path: null }, mode: "entries" },
      now(),
    );
    if (!promoted) {
      // Another caller replaced this operation while the target was in
      // flight. Its target is authoritative; drop ours and use theirs.
      const current = readOperation(db, backend, "pull");
      if (current === undefined) {
        throw new Error("sync: operation vanished during target capture");
      }
      operation = current;
    } else {
      const current = readOperation(db, backend, "pull");
      if (current === undefined) {
        throw new Error("sync: operation vanished after target capture");
      }
      operation = current;
    }
  }

  const target = operation.target;
  if (target === undefined) {
    throw new Error("sync: pending operation has no target");
  }

  const after = readFetchCursor(db, backend);

  // Already at the target: the operation is done. Delete the row and
  // report completion so a one-step alarm can stop without a second
  // next() call.
  if (compareChangeCursors(after, target) >= 0) {
    completeOperation(db, backend, "pull", operation.generation);
    return {
      operationId: operation.generation,
      generation: operation.generation,
      backend,
      direction: "pull",
      mode: operation.mode ?? "entries",
      cursor: after,
      targetCursor: target,
      entries: 0,
      bytes: 0,
      skipped: 0,
      complete: true,
    };
  }

  // A surviving marker with no cursor progress means the previous
  // execution died mid-block at this same cursor. Shrink the profile
  // before trying again so a block that did not fit is not retried at
  // the same size forever.
  const effectiveProfile =
    operation.blockAfter !== undefined && compareChangeCursors(operation.blockAfter, after) === 0
      ? (shrinkBlockProfile(db, backend, "pull", operation.generation, now()) ?? profile)
      : profile;

  markBlockStarted(db, backend, "pull", operation.generation, after, now());

  // 2. Ask the source for one deterministic block bounded by the
  //    fixed target. The remote streams entries; we stop reading at
  //    the profile bound and let the rest come in the next block.
  const fetchResult = await remote.fetchChanges({
    after,
    through: target,
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  });

  const entries: ChangeEntry[] = [];
  let bytes = 0;
  let drained = false;
  const reader = fetchResult.stream.getReader();
  try {
    while (entries.length < effectiveProfile.maxEntries) {
      const { value, done } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      entries.push(value);
      if (value.kind === "file") {
        for (const chunk of value.chunks) bytes += chunk.size;
      }
      // The first entry is always accepted so one oversized file still
      // makes progress; later entries stop the block at the bound.
      if (entries.length > 1 && bytes >= effectiveProfile.maxBytes) break;
    }
  } finally {
    reader.releaseLock();
    // No live stream reader crosses the yield boundary.
    await fetchResult.stream.cancel().catch(() => {});
    maybeDispose(fetchResult);
  }

  // 3. Pull the object bytes this block needs. Deduplicated within
  //    the block; duplicates across blocks are absorbed by the
  //    content-addressed store. Bytes are staged into the blob store
  //    rather than handed to applyChanges in memory, so a block's peak
  //    memory stays bounded by its metadata.
  const wanted: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    for (const chunk of entry.chunks) {
      const key = hex(chunk.hash);
      if (seen.has(key)) continue;
      seen.add(key);
      wanted.push(chunk.hash);
    }
  }
  if (wanted.length > 0) {
    // Ask for only what the source actually holds and we actually
    // lack. Requesting a hash the source has dropped would throw
    // EUNKNOWN_HASH and fail an otherwise applicable block.
    const remoteHas = new Set((await remote.hasObjects(wanted)).map(hex));
    const localHas = new Set(hasObjects(db, wanted).map(hex));
    const missing = wanted.filter((h) => remoteHas.has(hex(h)) && !localHas.has(hex(h)));
    if (missing.length > 0) {
      const objectStream = await remote.fetchObjects(missing);
      const objectReader = objectStream.getReader();
      try {
        while (true) {
          const { value, done } = await objectReader.read();
          if (done) break;
          // Stage before apply so a crash between the two replays as a
          // no-op rather than as a missing object.
          stageBlob(db, value.hash, value.bytes, now());
        }
      } finally {
        objectReader.releaseLock();
        maybeDispose(objectStream);
      }
    }
  }

  // 4. Apply metadata before the cursor moves. Chunk bytes come from
  //    the staged blob store, not from an in-memory map.
  const result = await applyChanges(db, entries, new Map(), {
    source: "upstream",
    backend,
  });

  // 5. Record refusals durably. The cursor advances past them so the
  //    operation cannot stall on an entry that can never apply, which
  //    would otherwise loop forever on the same rejection.
  for (const skip of result.skipped) {
    recordSkip(db, backend, "pull", operation.generation, skip.path, skip.reason, now());
  }

  // 6. Advance the cursor. Drained means every change through the
  //    target was offered, so the cursor jumps to the target itself.
  const lastEntry = entries[entries.length - 1];
  const cursor = drained ? target : lastEntry === undefined ? after : entryCursor(lastEntry);
  if (compareChangeCursors(cursor, after) > 0) {
    writeFetchCursor(db, cursor, backend);
  }
  clearBlockMarker(db, backend, "pull", operation.generation, now());

  // 7. Complete when the cursor reaches the fixed target.
  const complete = compareChangeCursors(cursor, target) >= 0;
  if (complete) {
    completeOperation(db, backend, "pull", operation.generation);
  }

  return {
    operationId: operation.generation,
    generation: operation.generation,
    backend,
    direction: "pull",
    mode: operation.mode ?? "entries",
    cursor,
    targetCursor: target,
    entries: entries.length,
    bytes,
    skipped: result.skipped.length,
    complete,
  };
}

// Join an in-flight block from the same isolate when one exists for
// this backend and direction, otherwise start one.
async function nextPullBlock(
  db: Database,
  remote: SyncRPC,
  backend: string,
  options: PullBlocksOptions,
): Promise<SyncProgress> {
  const key = activeKey(backend, "pull");
  const existing = active.get(key);
  if (existing !== undefined) {
    // Someone else in this isolate is already driving a block for this
    // backend. Wait for it rather than opening a duplicate transfer.
    try {
      return await existing.settled;
    } catch {
      // The other driver failed. Fall through and try our own block
      // from whatever durable state it left behind.
    }
  }

  const settled = runPullBlock(db, remote, backend, options);
  const operation = readOperation(db, backend, "pull");
  active.set(key, { generation: operation?.generation ?? "", settled });
  try {
    return await settled;
  } finally {
    if (active.get(key)?.settled === settled) active.delete(key);
  }
}

// Restartable pull. Each `next()` commits at most one block; the last
// value carries `complete: true` and the following `next()` ends the
// iteration.
//
// Recreating the iterable resumes from durable state, so a caller may
// drive one block per alarm, several per request, or abandon iteration
// entirely and pick it up later.
export function pullBlocks(
  db: Database,
  remote: SyncRPC,
  options: PullBlocksOptions = {},
): AsyncIterable<SyncProgress> {
  const backend = options.backend ?? DEFAULT_BACKEND;
  return {
    [Symbol.asyncIterator](): AsyncIterator<SyncProgress> {
      let finished = false;
      return {
        async next(): Promise<IteratorResult<SyncProgress>> {
          if (finished) return { done: true, value: undefined };
          const progress = await nextPullBlock(db, remote, backend, options);
          if (progress.complete) finished = true;
          return { done: false, value: progress };
        },
        // Breaking out of a for-await stops local driving but leaves
        // the operation pending. The last yielded cursor is durable and
        // a later iterator resumes from it.
        async return(): Promise<IteratorResult<SyncProgress>> {
          finished = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
}
