// R2Bucket — eager, streaming mount over a Cloudflare R2 binding.
//
// Indexing pages through R2 `list()` honouring `prefix`, then issues
// one `get()` per key and pipes the returned ReadableStream directly
// into `MountWriteAPI.writeFile`. No object body is ever buffered.
// Bounded concurrency keeps the fan-out predictable.
//
// Read-only in this milestone. put / delete proxies join later when
// the write-back path lands.
//
// Indexed exactly once per workspace store. After the first
// successful materialize() — even on an empty bucket — the mount is
// marked indexed=1 in _vfs_mounts and subsequent workspace boots
// over the same store skip it. New R2 objects landing after the
// first index are not picked up automatically; the workspace must
// be torn down and rebuilt over a fresh store.

import type { EagerMount, MountWriteAPI } from "../types.js";

// Duck-typed slice of the workers `R2Bucket` interface so callers
// can hand us either the real binding or a test fake without
// pulling `@cloudflare/workers-types` into this package's dep
// list.
export interface R2BucketBinding {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

export interface R2BucketOptions {
  // Stripped from R2 keys when computing relative paths inside the
  // mount root. Trailing slash optional; both "skills" and
  // "skills/" behave identically. Objects outside the prefix are
  // not surfaced.
  prefix?: string;
  // "read-only" (default) rejects writes through Workspace.fs with
  // EROFS. "read-write" is wired in a later milestone.
  mode?: "read-only" | "read-write";
  // Page size used for R2 `list()` calls. Default 1000 (R2's
  // documented maximum). Exposed mainly for tests that want to
  // exercise pagination without huge fixtures.
  listLimit?: number;
  // Bounded concurrency for the per-object `get()` fan-out. Default
  // 8 so we don't hammer R2 with one in-flight request per file in
  // a bucket of thousands.
  concurrency?: number;
  // Forwarded to the EagerMount.maxBytes cap honoured by the
  // indexer. Provider-level convenience so callers can express the
  // cap on the same options bag as `prefix`.
  maxBytes?: number;
  // Same idea for entry count.
  maxEntries?: number;
}

function normalisePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

async function* paginate(
  bucket: R2BucketBinding,
  prefix: string,
  limit: number,
): AsyncGenerator<{ key: string; size: number }> {
  let cursor: string | undefined;
  while (true) {
    const page = await bucket.list({
      prefix: prefix.length > 0 ? prefix : undefined,
      cursor,
      limit,
    });
    for (const obj of page.objects) yield obj;
    if (!page.truncated || !page.cursor) return;
    cursor = page.cursor;
  }
}

// Run `tasks` with at most `concurrency` in flight. Errors abort the
// remaining tasks by rejecting the returned promise; in-flight calls
// run to completion (no AbortController to thread through).
async function runBounded<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<void> {
  if (concurrency < 1) concurrency = 1;
  let next = 0;
  const workers: Promise<void>[] = [];
  let firstError: unknown;
  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          if (firstError !== undefined) return;
          const idx = next++;
          if (idx >= tasks.length) return;
          try {
            await tasks[idx]();
          } catch (error) {
            if (firstError === undefined) firstError = error;
            return;
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

export function R2Bucket(bucket: R2BucketBinding, options: R2BucketOptions = {}): EagerMount {
  const prefix = normalisePrefix(options.prefix);
  const mode = options.mode ?? "read-only";
  const listLimit = options.listLimit ?? 1000;
  const concurrency = options.concurrency ?? 8;

  return {
    kind: "r2",
    mode,
    strategy: "eager",
    maxBytes: options.maxBytes,
    maxEntries: options.maxEntries,
    async materialize(api: MountWriteAPI): Promise<void> {
      // First, collect every key. We could interleave the get()
      // fan-out with list() pages, but materialize() runs once at
      // cold start and the list is cheap relative to the gets; a
      // simple two-phase pass keeps the code obvious.
      const keys: Array<{ key: string; size: number }> = [];
      for await (const obj of paginate(bucket, prefix, listLimit)) {
        keys.push(obj);
      }

      const tasks = keys.map((entry) => async () => {
        const got = await bucket.get(entry.key);
        if (got === null) {
          throw new Error(`R2Bucket: object disappeared mid-materialize: ${entry.key}`);
        }
        const relKey = prefix.length > 0 ? entry.key.slice(prefix.length) : entry.key;
        if (relKey.length === 0) return; // skip a key equal to the prefix itself
        // Pipe the R2 body straight into the streaming writeFile.
        await api.writeFile(`${api.root}/${relKey}`, got.body);
      });
      await runBounded(tasks, concurrency);
    },
  };
}
