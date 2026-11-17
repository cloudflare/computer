// Workerd harness for the reaping end-to-end tests.
//
// Two Durable Objects:
//
//   - ReapHost owns a real Workspace and exposes a few RPC methods that
//     call its public API (fs, provider(), pull, push), plus read-only
//     probes of its storage so the test can check what was reaped.
//   - ReapPeer owns a dofs store served through the rpc package's real
//     sync server. ReapHost's only backend reaches it over Durable
//     Object RPC, so a pull or push between the two runs the real sync
//     engine on one side and the real receiver on the other.
//
// Workers RPC cannot carry object streams, so the backend adapter
// collects ChangeEntry and object streams into arrays at the boundary
// and rebuilds streams on the other side.

import { DurableObject } from "cloudflare:workers";
import type { ShellRPC, SyncRPC } from "@cloudflare/computer-rpc";
import { createSyncServer } from "@cloudflare/computer-rpc/server";
import type { ChangeCursor, ChangeEntry } from "@cloudflare/dofs";
import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";

import type { BackendHandle, WorkspaceBackend } from "../src/backend";
import { Workspace } from "../src/workspace";

// gc() is internal to dofs and is only used here as an oracle.
import { gc } from "../../dofs/src/fs/gc";

export interface Env {
  HOST: DurableObjectNamespace<ReapHost>;
  PEER: DurableObjectNamespace<ReapPeer>;
}

export interface StoreStats {
  blobs: number;
  manifests: number;
  databaseSize: number;
  // Chunks or manifests a node references whose rows are missing.
  dangling: number;
  // Blob rows nothing references, whatever their age.
  unreferencedBlobs: number;
}

function storeStats(sql: SqlStorage): StoreStats {
  const one = (query: string): number => Number(sql.exec(query).one().n);
  return {
    blobs: one("SELECT COUNT(*) AS n FROM vfs_blobs"),
    manifests: one("SELECT COUNT(*) AS n FROM vfs_manifests"),
    databaseSize: sql.databaseSize,
    dangling:
      one(
        `SELECT COUNT(*) AS n FROM vfs_chunks c
          WHERE NOT EXISTS (SELECT 1 FROM vfs_blob_bytes b WHERE b.hash = c.hash)`,
      ) +
      one(
        `SELECT COUNT(*) AS n FROM vfs_nodes n
          WHERE n.manifest_hash IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM vfs_manifests m WHERE m.hash = n.manifest_hash)`,
      ),
    unreferencedBlobs: one(
      `SELECT COUNT(*) AS n FROM vfs_blobs b
        WHERE NOT EXISTS (SELECT 1 FROM vfs_chunks c WHERE c.hash = b.hash)`,
    ),
  };
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

const noShell: ShellRPC = {
  async exec() {
    throw new Error("no shell in the reaping harness");
  },
  async getExec() {
    throw new Error("no shell in the reaping harness");
  },
  async killExec() {},
  async disposeExec() {},
};

// What a ReapHost may do on its own store while a sync with the peer is
// between its local probe and its apply.
type BetweenProbeAndApply = (() => Promise<void>) | undefined;

function peerBackend(
  peer: () => DurableObjectStub<ReapPeer>,
  between: () => BetweenProbeAndApply,
): WorkspaceBackend {
  const sync: SyncRPC = {
    async push(input) {
      return peer().push({
        senderRev: input.senderRev,
        senderCursor: input.senderCursor,
        changes: await collect(input.changes),
      });
    },
    async fetchChanges(input) {
      const result = await peer().fetchChanges(input);
      return {
        currentCursor: result.currentCursor,
        appliedPushCursor: result.appliedPushCursor,
        stream: streamOf(result.entries),
      };
    },
    async watermarks(input) {
      return peer().watermarks(input ?? {});
    },
    async readEntry(path) {
      return peer().readEntry(path);
    },
    async hasObjects(hashes) {
      return peer().hasObjects(hashes);
    },
    fetchObjects(hashes) {
      // The pull engine has already probed its own store when it asks
      // for what it lacks, so this is the moment between that probe and
      // the apply.
      return new ReadableStream({
        async start(controller) {
          await between()?.();
          for (const object of await peer().fetchObjects(hashes)) controller.enqueue(object);
          controller.close();
        },
      });
    },
    async pushObjects(objects) {
      await peer().pushObjects(await collect(objects));
    },
  };
  return {
    id: "peer",
    type: "reap-peer",
    async connect(): Promise<BackendHandle> {
      return { rpc: { sync, shell: noShell }, close: async () => {} };
    },
  };
}

export class ReapHost extends DurableObject<Env> {
  readonly #ws: Workspace;
  #peerName = "peer";
  #between: BetweenProbeAndApply;
  readonly #streams = new Map<
    string,
    { reader: ReadableStreamDefaultReader<Uint8Array>; parts: Uint8Array[] }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ws = new Workspace({
      storage: ctx.storage,
      backends: [
        peerBackend(
          () => this.env.PEER.get(this.env.PEER.idFromName(this.#peerName)),
          () => this.#between,
        ),
      ],
    });
  }

  async write(path: string, text: string): Promise<void> {
    await this.#ws.fs.writeFile(path, text);
  }

  // A streaming write whose source yields to the event loop between
  // pieces, so other requests can run in the middle of it.
  async writeStreaming(path: string, pieces: string[]): Promise<void> {
    let next = 0;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await scheduler.wait(1);
        if (next >= pieces.length) {
          controller.close();
          return;
        }
        controller.enqueue(new TextEncoder().encode(pieces[next++]));
      },
    });
    await this.#ws.fs.writeFile(path, source);
  }

  async read(path: string): Promise<string> {
    return this.#ws.fs.readFile(path, "utf8");
  }

  // Read a file another request may have removed: null when it is gone.
  // Any other failure, missing bytes above all, still throws.
  async readIfPresent(path: string): Promise<string | null> {
    try {
      return await this.#ws.fs.readFile(path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return null;
      throw error;
    }
  }

  async rm(path: string): Promise<void> {
    await this.#ws.fs.rm(path, { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#ws.fs.rename(from, to);
  }

  async truncate(path: string, size: number): Promise<void> {
    this.#ws.provider().truncateFileSync(path, size);
  }

  // Open a lazy binary read stream and keep it across requests. Returns
  // false when the file is gone.
  async openStream(id: string, path: string): Promise<boolean> {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.#ws.fs.readFile(path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return false;
      throw error;
    }
    this.#streams.set(id, { reader: stream.getReader(), parts: [] });
    return true;
  }

  // Pull one piece; returns false once the stream has ended.
  async pullStream(id: string): Promise<boolean> {
    const open = this.#streams.get(id);
    if (open === undefined) throw new Error(`no stream ${id}`);
    const { value, done } = await open.reader.read();
    if (!done) open.parts.push(value);
    return !done;
  }

  async streamText(id: string): Promise<string> {
    const open = this.#streams.get(id);
    if (open === undefined) throw new Error(`no stream ${id}`);
    const bytes = new Uint8Array(open.parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of open.parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  async stats(): Promise<StoreStats> {
    return storeStats(this.ctx.storage.sql);
  }

  // What gc() frees with no safety window. Destructive: call last.
  async gcNow(): Promise<{ blobsFreed: number; manifestsFreed: number }> {
    // The Workspace's Database comes from the dofs build, gc() from its
    // source; they are the same class at runtime.
    const db = this.#ws.db as unknown as Parameters<typeof gc>[0];
    return gc(db, { safetyWindowMs: 0, now: () => Number.MAX_SAFE_INTEGER });
  }

  // Stand in for wall-clock time passing: move every blob and manifest
  // row's last_seen back by `ms`. The sweep compares last_seen against
  // Date.now(), which a test cannot move inside workerd.
  async ageContent(ms: number): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE vfs_blobs SET last_seen = last_seen - ?", ms);
    this.ctx.storage.sql.exec("UPDATE vfs_manifests SET last_seen = last_seen - ?", ms);
  }

  // Throw away this instance and everything it holds in memory, as an
  // eviction or a crash would.
  async restart(): Promise<void> {
    this.ctx.abort("restart requested by the test");
  }

  async usePeer(name: string): Promise<void> {
    this.#peerName = name;
  }

  // Arrange for `path` to be overwritten with `text` once, after the
  // next pull has probed this store and before it applies.
  async overwriteBetweenProbeAndApply(path: string, text: string): Promise<void> {
    this.#between = async () => {
      this.#between = undefined;
      await this.#ws.fs.writeFile(path, text);
    };
  }

  async pull(): Promise<number> {
    let blocks = 0;
    for await (const _ of this.#ws.pull("peer")) blocks++;
    return blocks;
  }

  async push(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      for await (const _ of this.#ws.push("peer")) {
        // Drain.
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String((error as Error).message ?? error) };
    }
  }
}

export class ReapPeer extends DurableObject<Env> {
  readonly #db: Database;
  readonly #fs: WorkspaceFilesystem;
  readonly #server: SyncRPC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#db = new Database(ctx.storage);
    initializeSchema(this.#db, Date.now);
    this.#fs = new WorkspaceFilesystem(this.#db, { now: Date.now });
    this.#server = createSyncServer(this.#db);
  }

  async write(path: string, text: string): Promise<void> {
    await this.#fs.writeFile(path, text);
  }

  async read(path: string): Promise<string> {
    return this.#fs.readFile(path, "utf8");
  }

  async stats(): Promise<StoreStats> {
    return storeStats(this.ctx.storage.sql);
  }

  async push(input: {
    senderRev: number;
    senderCursor?: ChangeCursor;
    changes: ChangeEntry[];
  }): Promise<Awaited<ReturnType<SyncRPC["push"]>>> {
    return this.#server.push({ ...input, changes: streamOf(input.changes) });
  }

  async fetchChanges(input: Parameters<SyncRPC["fetchChanges"]>[0]): Promise<{
    currentCursor: ChangeCursor;
    appliedPushCursor: ChangeCursor;
    entries: ChangeEntry[];
  }> {
    const result = await this.#server.fetchChanges(input);
    return {
      currentCursor: result.currentCursor,
      appliedPushCursor: result.appliedPushCursor,
      entries: await collect(result.stream),
    };
  }

  async watermarks(input: {
    settle?: boolean;
  }): Promise<Awaited<ReturnType<SyncRPC["watermarks"]>>> {
    return this.#server.watermarks(input);
  }

  async readEntry(path: string): Promise<ChangeEntry | null> {
    return this.#server.readEntry(path);
  }

  async hasObjects(hashes: Uint8Array[]): Promise<Uint8Array[]> {
    return this.#server.hasObjects(hashes);
  }

  async fetchObjects(
    hashes: Uint8Array[],
  ): Promise<Array<{ hash: Uint8Array; bytes: Uint8Array }>> {
    return collect(this.#server.fetchObjects(hashes));
  }

  async pushObjects(objects: Array<{ hash: Uint8Array; bytes: Uint8Array }>): Promise<void> {
    await this.#server.pushObjects(streamOf(objects));
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
