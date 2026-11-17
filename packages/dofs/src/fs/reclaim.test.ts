import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "../storage";
import { applyChanges, applyChangesSync } from "../sync/apply";
import type { ChangeEntry } from "../sync/changes";
import { hasObjects } from "../sync/fetch";
import { gc } from "./gc";
import { link } from "./link";
import { mkdir } from "./mkdir";
import { pinHashes, STREAM_IDLE_LEASE_MS } from "./pins";
import { readFile } from "./readFile";
import { dropChunks, isDeferred } from "./refs";
import { rename } from "./rename";
import { resolveInode } from "./resolve";
import { rm } from "./rm";
import { withDB } from "./with-db";
import {
  CHUNK_SIZE,
  openWriteBufferSync,
  releaseWriteBufferSync,
  truncateFileSync,
  writeFile,
  writeFileRangesSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile";

const NOW = (): number => 1000;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function count(db: Database, table: string): number {
  return db.scalar<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0;
}

function hasBlob(db: Database, bytes: Uint8Array): boolean {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs WHERE hash = ?", sha256(bytes)) === 1;
}

// What gc() still finds to free with no safety window. It deletes what
// it finds, so call it last.
function orphansLeft(db: Database): { blobs: number; manifests: number } {
  const freed = gc(db, { safetyWindowMs: 0, now: () => Number.MAX_SAFE_INTEGER });
  return { blobs: freed.blobsFreed, manifests: freed.manifestsFreed };
}

function fileEntry(path: string, bytes: Uint8Array, rev: number): ChangeEntry {
  return {
    kind: "file",
    rev,
    path,
    mode: 0o644,
    mtime: 1,
    size: bytes.byteLength,
    chunks: [{ hash: sha256(bytes), size: bytes.byteLength }],
  };
}

function twoChunks(first: number, second: number): Uint8Array {
  const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(first);
  bytes.fill(second, CHUNK_SIZE);
  return bytes;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reclaiming dropped content", () => {
  it("keeps one blob and one manifest however often a file is saved", async () => {
    await withDB(async (db) => {
      for (let save = 0; save < 20; save++) {
        await writeFile(db, "/notes.md", `draft ${save}`, {}, NOW);
      }
      expect(count(db, "vfs_blobs")).toBe(1);
      expect(count(db, "vfs_blob_bytes")).toBe(1);
      expect(count(db, "vfs_manifests")).toBe(1);
      expect(await readFile(db, "/notes.md", "utf8")).toBe("draft 19");
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees a file's content when its last name is removed", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "unique", {}, NOW);
      rm(db, "/a.txt", {});
      expect(count(db, "vfs_blobs")).toBe(0);
      expect(count(db, "vfs_blob_bytes")).toBe(0);
      expect(count(db, "vfs_manifests")).toBe(0);
    });
  });

  it("frees a whole tree removed recursively", async () => {
    await withDB((db) => {
      mkdir(db, "/d/e", { recursive: true }, NOW);
      writeFileSync(db, "/d/a.txt", encode("a"), {}, NOW);
      writeFileSync(db, "/d/e/b.txt", encode("b"), {}, NOW);
      rm(db, "/d", { recursive: true });
      expect(count(db, "vfs_blobs")).toBe(0);
      expect(count(db, "vfs_manifests")).toBe(0);
    });
  });

  it("keeps content another file still uses", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "same", {}, NOW);
      await writeFile(db, "/b.txt", "same", {}, NOW);
      rm(db, "/a.txt", {});
      expect(await readFile(db, "/b.txt", "utf8")).toBe("same");
      expect(count(db, "vfs_blobs")).toBe(1);
      expect(count(db, "vfs_manifests")).toBe(1);
      rm(db, "/b.txt", {});
      expect(count(db, "vfs_blobs")).toBe(0);
      expect(count(db, "vfs_manifests")).toBe(0);
    });
  });

  it("keeps content a hardlink still names", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "linked", {}, NOW);
      link(db, "/a.txt", "/b.txt");
      rm(db, "/a.txt", {});
      expect(await readFile(db, "/b.txt", "utf8")).toBe("linked");
      rm(db, "/b.txt", {});
      expect(count(db, "vfs_blobs")).toBe(0);
    });
  });

  it("keeps the chunks a rewrite reuses and frees the rest", async () => {
    await withDB((db) => {
      writeFileSync(db, "/big.bin", twoChunks(1, 2), {}, NOW);
      writeFileSync(db, "/big.bin", twoChunks(1, 3), {}, NOW);
      expect(count(db, "vfs_blobs")).toBe(2);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees the chunk a range write replaces, and the stale manifest", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", encode("aaaa"), {}, NOW);
      writeRangeSync(db, "/a.txt", encode("b"), 0, {}, NOW);
      expect(hasBlob(db, encode("aaaa"))).toBe(false);
      expect(hasBlob(db, encode("baaa"))).toBe(true);
      expect(count(db, "vfs_manifests")).toBe(0);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees what a partial rewrite replaces", async () => {
    await withDB((db) => {
      writeFileSync(db, "/big.bin", twoChunks(1, 2), {}, NOW);
      const next = twoChunks(1, 4);
      writeFileRangesSync(
        db,
        "/big.bin",
        next,
        [{ start: CHUNK_SIZE, end: next.byteLength }],
        {},
        NOW,
      );
      expect(count(db, "vfs_blobs")).toBe(2);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees the tail a truncate cuts off, and everything a truncate to zero drops", async () => {
    await withDB((db) => {
      writeFileSync(db, "/big.bin", twoChunks(1, 2), {}, NOW);
      truncateFileSync(db, "/big.bin", CHUNK_SIZE, NOW);
      expect(count(db, "vfs_blobs")).toBe(1);
      truncateFileSync(db, "/big.bin", 0, NOW);
      expect(count(db, "vfs_blobs")).toBe(0);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees the old content when a write buffer is released", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", encode("before"), {}, NOW);
      openWriteBufferSync(db, "/a.txt");
      writeRangeSync(db, "/a.txt", encode("AFTER!"), 0, {}, NOW);
      releaseWriteBufferSync(db, "/a.txt", NOW);
      expect(hasBlob(db, encode("before"))).toBe(false);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });

      openWriteBufferSync(db, "/a.txt");
      truncateFileSync(db, "/a.txt", 0, NOW);
      releaseWriteBufferSync(db, "/a.txt", NOW);
      expect(count(db, "vfs_blobs")).toBe(0);
    });
  });

  it("frees the content a rename displaces", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", encode("mover"), {}, NOW);
      writeFileSync(db, "/b.txt", encode("displaced"), {}, NOW);
      rename(db, "/a.txt", "/b.txt");
      expect(hasBlob(db, encode("displaced"))).toBe(false);
      expect(hasBlob(db, encode("mover"))).toBe(true);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("frees what a sync apply removes once the apply ends", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/gone.txt", encode("remote deleted me"), {}, NOW);
      await applyChanges(db, [{ kind: "delete", rev: 1, path: "/gone.txt" }], new Map());
      expect(count(db, "vfs_blobs")).toBe(0);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });
});

describe("content in use is not reclaimed", () => {
  it("lets an open read stream finish after its file is overwritten", async () => {
    await withDB(async (db) => {
      const old = twoChunks(5, 6);
      writeFileSync(db, "/big.bin", old, {}, NOW);
      const stream = await readFile(db, "/big.bin");

      writeFileSync(db, "/big.bin", encode("new"), {}, NOW);

      expect(sha256(await drain(stream))).toEqual(sha256(old));
      // Later writes reap what the stream held, one chunk's worth each.
      writeFileSync(db, "/other.txt", encode("x"), {}, NOW);
      writeFileSync(db, "/other.txt", encode("y"), {}, NOW);
      expect(count(db, "vfs_blobs")).toBe(2);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("reclaims what a dropped stream held once its lease runs out", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/a.txt", encode("abandoned"), {}, NOW);
      await readFile(db, "/a.txt");
      writeFileSync(db, "/a.txt", encode("next"), {}, NOW);
      expect(hasBlob(db, encode("abandoned"))).toBe(true);
      expect(isDeferred(db, sha256(encode("abandoned")))).toBe(true);

      vi.advanceTimersByTime(STREAM_IDLE_LEASE_MS);
      writeFileSync(db, "/b.txt", encode("later"), {}, NOW);

      expect(hasBlob(db, encode("abandoned"))).toBe(false);
      expect(isDeferred(db, sha256(encode("abandoned")))).toBe(false);
    });
  });

  it("links content hasObjects reported present, even after a local overwrite", async () => {
    await withDB(async (db) => {
      const shared = encode("the peer will not resend this");
      writeFileSync(db, "/local.txt", shared, {}, NOW);
      expect(hasObjects(db, [sha256(shared)])).toHaveLength(1);

      writeFileSync(db, "/local.txt", encode("changed locally"), {}, NOW);
      await applyChanges(db, [fileEntry("/from-peer.txt", shared, 1)], new Map());

      expect(await readFile(db, "/from-peer.txt", "utf8")).toBe("the peer will not resend this");
    });
  });

  it("applies a rename that arrives as a delete and a file in one block", async () => {
    await withDB(async (db) => {
      const moved = encode("moved content");
      writeFileSync(db, "/old.txt", moved, {}, NOW);

      await applyChanges(
        db,
        [{ kind: "delete", rev: 2, path: "/old.txt" }, fileEntry("/new.txt", moved, 2)],
        new Map(),
      );

      expect(await readFile(db, "/new.txt", "utf8")).toBe("moved content");
      expect(count(db, "vfs_blobs")).toBe(1);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("applies the same rename through the synchronous apply", async () => {
    await withDB((db) => {
      const moved = encode("moved content");
      writeFileSync(db, "/old.txt", moved, {}, NOW);

      applyChangesSync(
        db,
        [{ kind: "delete", rev: 2, path: "/old.txt" }, fileEntry("/new.txt", moved, 2)],
        new Map(),
      );

      expect(count(db, "vfs_blobs")).toBe(1);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("finishes a streaming write whose staged chunk another file dropped meanwhile", async () => {
    await withDB(async (db) => {
      const window = new Uint8Array(CHUNK_SIZE).fill(9);
      writeFileSync(db, "/twin.bin", window, {}, NOW);
      let sent = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(window);
          else if (sent === 1) {
            // The window is staged. Drop the only other reference to it.
            writeFileSync(db, "/twin.bin", encode("changed"), {}, NOW);
            controller.enqueue(encode("tail"));
          } else controller.close();
          sent++;
        },
      });

      await writeFile(db, "/streamed.bin", source, {}, NOW);

      const read = await drain(await readFile(db, "/streamed.bin"));
      expect(read.byteLength).toBe(CHUNK_SIZE + 4);
      expect(sha256(read.subarray(0, CHUNK_SIZE))).toEqual(sha256(window));
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });

  it("defers a pinned hash and reclaims it on a later write once released", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", encode("held"), {}, NOW);
      const pin = pinHashes(db, [sha256(encode("held"))]);
      writeFileSync(db, "/a.txt", encode("next"), {}, NOW);
      expect(hasBlob(db, encode("held"))).toBe(true);

      pin.release();
      writeFileSync(db, "/b.txt", encode("other"), {}, NOW);
      expect(hasBlob(db, encode("held"))).toBe(false);
    });
  });

  it("keeps content when the write that dropped it rolls back", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/a.txt", encode("survivor"), {}, NOW);
      const inode = resolveInode(db, "/a.txt")?.inode ?? 0;
      expect(() =>
        db.transactionSync(() => {
          dropChunks(db, inode);
          throw new Error("abort");
        }),
      ).toThrow("abort");
      writeFileSync(db, "/b.txt", encode("other"), {}, NOW);
      expect(await readFile(db, "/a.txt", "utf8")).toBe("survivor");
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });
});

describe("reaping in batches", () => {
  // A Database over the same storage that counts the statements that
  // delete content rows.
  function counting(db: Database): { db: Database; deletes: () => number } {
    let deletes = 0;
    const wrapped = new Database({
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          if (/^\s*DELETE\s+FROM\s+vfs_(blobs|blob_bytes|manifests)\b/i.test(query)) deletes++;
          return db.sql.exec(query, ...bindings);
        },
      },
      transactionSync: (closure) => db.transactionSync(closure),
    });
    return { db: wrapped, deletes: () => deletes };
  }

  it("reaps a recursive delete of many distinct files in a few statements", async () => {
    await withDB((db) => {
      mkdir(db, "/tree", {}, NOW);
      for (let i = 0; i < 250; i++) writeFileSync(db, `/tree/f${i}`, encode(`file ${i}`), {}, NOW);
      const view = counting(db);

      rm(view.db, "/tree", { recursive: true });

      expect(count(db, "vfs_blobs")).toBe(0);
      expect(count(db, "vfs_blob_bytes")).toBe(0);
      expect(count(db, "vfs_manifests")).toBe(0);
      // Blobs, their bytes and manifests, up to 100 hashes a statement.
      expect(view.deletes()).toBeLessThanOrEqual(3 * Math.ceil(250 / 100));
    });
  });

  it("keeps what is still referenced when a batch mixes both", async () => {
    await withDB((db) => {
      mkdir(db, "/tree", {}, NOW);
      for (let i = 0; i < 150; i++) writeFileSync(db, `/tree/f${i}`, encode(`file ${i}`), {}, NOW);
      writeFileSync(db, "/kept", encode("file 7"), {}, NOW);

      rm(db, "/tree", { recursive: true });

      expect(count(db, "vfs_blobs")).toBe(1);
      expect(hasBlob(db, encode("file 7"))).toBe(true);
      expect(orphansLeft(db)).toEqual({ blobs: 0, manifests: 0 });
    });
  });
});
