// Workerd harness for the rpc push receiver in a Durable Object.
//
// Receiver owns a dofs store on its own SQLite storage and serves it
// through the rpc package's sync server. The test pushes batches the
// way a sender would: objects first, then the entries that reference
// them. The receiver applies each batch inside one transactionSync,
// which nests the transactions of every filesystem write it makes.

import { DurableObject } from "cloudflare:workers";
import type { SyncRPC } from "@cloudflare/computer-rpc";
import { createSyncServer } from "@cloudflare/computer-rpc/server";
import type { ChangeEntry } from "@cloudflare/dofs";
import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";

export interface Env {
  RECEIVER: DurableObjectNamespace<Receiver>;
}

function streamOf<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const item of items) controller.enqueue(item);
      controller.close();
    },
  });
}

export class Receiver extends DurableObject<Env> {
  readonly #fs: WorkspaceFilesystem;
  readonly #server: SyncRPC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new Database(ctx.storage);
    initializeSchema(db, Date.now);
    this.#fs = new WorkspaceFilesystem(db, { now: Date.now });
    this.#server = createSyncServer(db);
  }

  async write(path: string, text: string): Promise<void> {
    await this.#fs.writeFile(path, text);
  }

  async read(path: string): Promise<string | null> {
    return this.#fs.readFile(path, "utf8").catch(() => null);
  }

  async receive(
    senderRev: number,
    objects: Array<{ hash: Uint8Array; bytes: Uint8Array }>,
    entries: ChangeEntry[],
  ): Promise<{ ok: true; applied: number | undefined } | { ok: false; message: string }> {
    try {
      await this.#server.pushObjects(streamOf(objects));
      const result = await this.#server.push({
        senderRev,
        senderCursor: { rev: senderRev, path: null },
        changes: streamOf(entries),
      });
      return { ok: true, applied: result.applied };
    } catch (error) {
      return { ok: false, message: String((error as Error).message ?? error) };
    }
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("ok");
  },
};
