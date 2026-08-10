import { describe, expect, it } from "vitest";

import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { CHUNK_SIZE, writeFile, writeFileRangesSync, writeFileSync } from "./writeFile.js";

// Reassemble a file's bytes by stitching its chunk rows together.
// A deliberately minimal helper so writeFile tests can stand alone
// without depending on readFile.
function readBack(db: Database, path: string): Uint8Array {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`no such path: ${path}`);
  if (node.type !== "file") throw new Error(`not a file: ${path}`);
  const chunks = db.all<{ hash: Uint8Array; size: number }>(
    "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const chunk of chunks) {
    const row = db.one<{ bytes: Uint8Array }>(
      "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
      chunk.hash,
    );
    if (row === undefined) throw new Error("missing blob bytes");
    parts.push(row.bytes);
    total += row.bytes.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function chunkRows(db: Database, path: string): Array<{ hash: Uint8Array; size: number }> {
  const node = resolveInode(db, path);
  if (node === null) throw new Error(`no such path: ${path}`);
  return db.all<{ hash: Uint8Array; size: number }>(
    "SELECT hash, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
    node.inode,
  );
}

function countBlobs(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
}

describe("writeFile", () => {
  it("writes a small string and stores one chunk", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/hello.txt", "hello fuse", {}, () => 1234);

      const bytes = readBack(db, "/hello.txt");
      expect(new TextDecoder().decode(bytes)).toBe("hello fuse");

      const chunkCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_chunks WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?)",
        ROOT_INODE,
        "hello.txt",
      );
      expect(chunkCount).toBe(1);
    });
  });

  it("writeFileSync stores small strings as a single chunk row", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/hello.txt", new TextEncoder().encode("hello fuse"), {}, () => 1234);

      const bytes = readBack(db, "/hello.txt");
      expect(new TextDecoder().decode(bytes)).toBe("hello fuse");

      const chunkCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_chunks WHERE inode = (SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?)",
        ROOT_INODE,
        "hello.txt",
      );
      expect(chunkCount).toBe(1);
    });
  });

  it("atomically rejects an exclusive write when the target exists", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/exclusive.txt", "first", {}, () => 1);
      await expect(
        writeFile(db, "/exclusive.txt", "second", { exclusive: true }, () => 2),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(new TextDecoder().decode(readBack(db, "/exclusive.txt"))).toBe("first");
    });
  });

  it("rejects an exclusive streaming write before reading its source", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/exclusive-stream.txt", "first", {}, () => 1);
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode("second"));
          },
        },
        { highWaterMark: 0 },
      );
      await expect(
        writeFile(db, "/exclusive-stream.txt", source, { exclusive: true }, () => 2),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(pulls).toBe(0);
    });
  });

  it("accepts a Uint8Array", async () => {
    await withDB(async (db) => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await writeFile(db, "/data.bin", data, {}, () => 0);
      expect(Array.from(readBack(db, "/data.bin"))).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it("accepts a ReadableStream and joins its chunks", async () => {
    await withDB(async (db) => {
      await writeFile(
        db,
        "/streamed.txt",
        streamOf(new TextEncoder().encode("hello "), new TextEncoder().encode("stream")),
        {},
        () => 0,
      );
      expect(new TextDecoder().decode(readBack(db, "/streamed.txt"))).toBe("hello stream");
    });
  });

  it("writes an empty file (zero chunks, zero size)", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/empty", "", {}, () => 0);
      const node = resolveInode(db, "/empty");
      expect(node?.type).toBe("file");
      const chunks = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_chunks WHERE inode = ?",
        node?.inode,
      );
      expect(chunks).toBe(0);
    });
  });

  it("splits content larger than CHUNK_SIZE across multiple chunks", async () => {
    await withDB(async (db) => {
      const oneChunk = new Uint8Array(CHUNK_SIZE);
      oneChunk.fill(0x41);
      const trailing = new Uint8Array(100);
      trailing.fill(0x42);
      const combined = new Uint8Array(CHUNK_SIZE + 100);
      combined.set(oneChunk, 0);
      combined.set(trailing, CHUNK_SIZE);
      await writeFile(db, "/big", combined, {}, () => 0);

      const node = resolveInode(db, "/big");
      const chunkCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_chunks WHERE inode = ?",
        node?.inode,
      );
      expect(chunkCount).toBe(2);

      const sizes = db
        .all<{ idx: number; size: number }>(
          "SELECT idx, size FROM vfs_chunks WHERE inode = ? ORDER BY idx",
          node?.inode,
        )
        .map((r) => r.size);
      expect(sizes).toEqual([CHUNK_SIZE, 100]);

      const round = readBack(db, "/big");
      expect(round.byteLength).toBe(CHUNK_SIZE + 100);
      expect(round[0]).toBe(0x41);
      expect(round[CHUNK_SIZE]).toBe(0x42);
    });
  });

  it("range writes reuse unchanged chunks", async () => {
    await withDB(async (db) => {
      const first = new Uint8Array(CHUNK_SIZE);
      first.fill(0x41);
      const second = new Uint8Array(CHUNK_SIZE);
      second.fill(0x42);
      const third = new Uint8Array(CHUNK_SIZE);
      third.fill(0x43);
      const original = new Uint8Array(3 * CHUNK_SIZE);
      original.set(first, 0);
      original.set(second, CHUNK_SIZE);
      original.set(third, 2 * CHUNK_SIZE);
      await writeFile(db, "/big", original, {}, () => 100);
      const beforeChunks = chunkRows(db, "/big");

      let stagedBlobs = 0;
      const run = db.run.bind(db);
      db.run = (query: string, ...bindings: unknown[]) => {
        if (query.startsWith("INSERT INTO vfs_blobs")) stagedBlobs += 1;
        return run(query, ...bindings);
      };

      const next = new Uint8Array(original);
      const changedOffset = CHUNK_SIZE + 123;
      next[changedOffset] = 0x99;
      writeFileRangesSync(
        db,
        "/big",
        next,
        [{ start: changedOffset, end: changedOffset + 1 }],
        {},
        () => 200,
      );

      expect(stagedBlobs).toBe(1);
      expect(Array.from(readBack(db, "/big"))).toEqual(Array.from(next));
      const afterChunks = chunkRows(db, "/big");
      expect(afterChunks).toHaveLength(3);
      expect(afterChunks[0].hash).toEqual(beforeChunks[0].hash);
      expect(afterChunks[1].hash).not.toEqual(beforeChunks[1].hash);
      expect(afterChunks[2].hash).toEqual(beforeChunks[2].hash);
    });
  });

  it("dedups identical content across two paths into one blob row", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "shared", {}, () => 0);
      await writeFile(db, "/b.txt", "shared", {}, () => 0);
      expect(countBlobs(db)).toBe(1);
    });
  });

  it("overwriting reuses the blob when content is unchanged", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "same", {}, () => 0);
      const before = countBlobs(db);
      await writeFile(db, "/x.txt", "same", {}, () => 0);
      expect(countBlobs(db)).toBe(before);
    });
  });

  it("overwriting replaces chunk rows; old content blob remains for GC", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "first", {}, () => 0);
      await writeFile(db, "/x.txt", "second-version", {}, () => 0);
      expect(new TextDecoder().decode(readBack(db, "/x.txt"))).toBe("second-version");
      expect(countBlobs(db)).toBe(2);
    });
  });

  it("rejects ENOENT when the parent directory is missing", async () => {
    await withDB(async (db) => {
      await expect(writeFile(db, "/no/such/dir/file.txt", "hi", {}, () => 0)).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    });
  });

  it("rejects ENOTDIR when a deep parent path segment is a file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "file", {}, () => 0);

      await expect(
        writeFile(db, "/target/sub/child.txt", "hello", {}, () => 0),
      ).rejects.toMatchObject({ code: "ENOTDIR" });
    });
  });

  it("rejects EISDIR when the path resolves to a directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await expect(writeFile(db, "/d", "x", {}, () => 0)).rejects.toMatchObject({
        code: "EISDIR",
      });
    });
  });

  it("honors mode and bumps rev on first write", async () => {
    await withDB(async (db) => {
      const beforeRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      await writeFile(db, "/run.sh", "#!/bin/sh\n", { mode: 0o755 }, () => 4242);
      const node = resolveInode(db, "/run.sh");
      expect(node?.mode).toBe(0o755);
      expect(node?.mtime).toBe(4242);
      const afterRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      expect(afterRev).toBe((beforeRev ?? 0) + 1);
      const nodeRev = db.scalar<number>("SELECT rev FROM vfs_nodes WHERE inode = ?", node?.inode);
      expect(nodeRev).toBe(afterRev);
    });
  });

  it("updates mtime and rev on overwrite", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x.txt", "v1", {}, () => 100);
      const v1 = resolveInode(db, "/x.txt");
      const v1Rev = db.scalar<number>("SELECT rev FROM vfs_nodes WHERE inode = ?", v1?.inode);

      await writeFile(db, "/x.txt", "v2", {}, () => 200);
      const v2 = resolveInode(db, "/x.txt");
      expect(v2?.inode).toBe(v1?.inode);
      expect(v2?.mtime).toBe(200);
      const v2Rev = db.scalar<number>("SELECT rev FROM vfs_nodes WHERE inode = ?", v2?.inode);
      expect((v2Rev ?? 0) > (v1Rev ?? 0)).toBe(true);
    });
  });

  it("writes into a nested directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/c.txt", "nested", {}, () => 0);
      expect(new TextDecoder().decode(readBack(db, "/a/b/c.txt"))).toBe("nested");
    });
  });

  it("writes through an intermediate symlink to a directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      symlink(db, "/real", "/linkdir", () => 0);

      await writeFile(db, "/linkdir/file.txt", "hello", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/real/file.txt"))).toBe("hello");
    });
  });

  it("invalidates a cached miss at the resolved path after writing through a symlinked parent", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      symlink(db, "/real", "/linkdir", () => 0);
      expect(resolveInode(db, "/real/file.txt")).toBeNull();

      await writeFile(db, "/linkdir/file.txt", "hello", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/real/file.txt"))).toBe("hello");
    });
  });

  it("writes through an intermediate relative symlink to a directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/base/real", { recursive: true }, () => 0);
      symlink(db, "real", "/base/linkdir", () => 0);

      await writeFile(db, "/base/linkdir/file.txt", "hello", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/base/real/file.txt"))).toBe("hello");
    });
  });

  it("resolves a relative final symlink from its real parent", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real/nested", { recursive: true }, () => 0);
      symlink(db, "/real/nested", "/alias", () => 0);
      symlink(db, "../target", "/real/nested/link", () => 0);

      await writeFile(db, "/alias/link", "hello", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/real/target"))).toBe("hello");
      expect(new TextDecoder().decode(readBack(db, "/alias/link"))).toBe("hello");
      expect(resolveInode(db, "/target")).toBeNull();
    });
  });

  it("expands a symlink before applying a later parent segment in its target", async () => {
    await withDB(async (db) => {
      mkdir(db, "/base/dir", { recursive: true }, () => 0);
      mkdir(db, "/other/deep", { recursive: true }, () => 0);
      symlink(db, "/other/deep", "/base/dir/alias", () => 0);
      symlink(db, "alias/../target", "/base/dir/link", () => 0);

      await writeFile(db, "/base/dir/link", "hello", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/other/target"))).toBe("hello");
      expect(new TextDecoder().decode(readBack(db, "/base/dir/link"))).toBe("hello");
      expect(resolveInode(db, "/base/dir/target")).toBeNull();
    });
  });

  it("rejects ENOTDIR when an intermediate symlink resolves to a file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "file", {}, () => 0);
      symlink(db, "/target", "/linkfile", () => 0);

      await expect(
        writeFile(db, "/linkfile/child.txt", "hello", {}, () => 0),
      ).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });
  });

  it("rejects ELOOP when an intermediate symlink is cyclic", async () => {
    await withDB(async (db) => {
      symlink(db, "/b", "/a", () => 0);
      symlink(db, "/a", "/b", () => 0);

      await expect(writeFile(db, "/a/child.txt", "hello", {}, () => 0)).rejects.toMatchObject({
        code: "ELOOP",
      });
    });
  });

  it("counts intermediate and final symlinks against one follow limit", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      for (let index = 29; index >= 0; index--) {
        const target = index === 29 ? "/real" : `/dir-${index + 1}`;
        symlink(db, target, `/dir-${index}`, () => 0);
      }
      for (let index = 19; index >= 0; index--) {
        const target = index === 19 ? "/missing" : `/file-${index + 1}`;
        symlink(db, target, `/file-${index}`, () => 0);
      }
      symlink(db, "/file-0", "/real/link", () => 0);

      await expect(writeFile(db, "/dir-0/link", "hello", {}, () => 0)).rejects.toMatchObject({
        code: "ELOOP",
      });
      expect(resolveInode(db, "/missing")).toBeNull();
    });
  });

  it("writes through a final symlink to its target", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "old", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);

      await writeFile(db, "/link", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/target"))).toBe("new");
      expect(new TextDecoder().decode(readBack(db, "/link"))).toBe("new");
      expect(
        db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_chunks c JOIN vfs_nodes n ON n.inode = c.inode WHERE n.type = 'symlink'",
        ),
      ).toBe(0);
      expect(db.scalar<number>("SELECT size FROM vfs_nodes WHERE type = 'symlink'")).toBe(0);
    });
  });

  it("creates the target when writing through a dangling final symlink", async () => {
    await withDB(async (db) => {
      symlink(db, "/created", "/link", () => 0);

      await writeFile(db, "/link", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/created"))).toBe("new");
    });
  });

  it("creates a relative target from the symlink parent when writing through a dangling final symlink", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dir", {}, () => 0);
      symlink(db, "created", "/dir/link", () => 0);

      await writeFile(db, "/dir/link", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/dir/created"))).toBe("new");
    });
  });

  it("clamps final symlink targets that climb above the root", async () => {
    await withDB(async (db) => {
      symlink(db, "../../created", "/link", () => 0);

      await writeFile(db, "/link", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/created"))).toBe("new");
      expect(new TextDecoder().decode(readBack(db, "/link"))).toBe("new");
    });
  });

  it("clamps intermediate symlink targets that climb above the root", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      symlink(db, "../../real", "/linkdir", () => 0);

      await writeFile(db, "/linkdir/file.txt", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/real/file.txt"))).toBe("new");
    });
  });

  it("creates the missing target at the end of a dangling symlink chain", async () => {
    await withDB(async (db) => {
      symlink(db, "/mid", "/link", () => 0);
      symlink(db, "/missing", "/mid", () => 0);

      await writeFile(db, "/link", "new", {}, () => 0);

      expect(new TextDecoder().decode(readBack(db, "/missing"))).toBe("new");
      expect(resolveInode(db, "/mid", { followSymlinks: false })?.type).toBe("symlink");
    });
  });

  it("keeps exclusive writes on a final symlink from following the link", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "old", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);

      await expect(
        writeFile(db, "/link", "new", { exclusive: true }, () => 0),
      ).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(new TextDecoder().decode(readBack(db, "/target"))).toBe("old");
    });
  });

  it("range writes follow a final symlink", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target", "abc", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);

      writeFileRangesSync(
        db,
        "/link",
        new TextEncoder().encode("axc"),
        [{ start: 1, end: 2 }],
        {},
        () => 0,
      );

      expect(new TextDecoder().decode(readBack(db, "/target"))).toBe("axc");
      expect(
        db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_chunks c JOIN vfs_nodes n ON n.inode = c.inode WHERE n.type = 'symlink'",
        ),
      ).toBe(0);
    });
  });

  it("stages blobs incrementally as the stream produces them", async () => {
    await withDB(async (db) => {
      // Stream 3 CHUNK_SIZE-aligned source chunks. After the first
      // is pulled, the receiver should have already staged it —
      // we don't want to wait for the whole stream to drain.
      const filler = new Uint8Array(CHUNK_SIZE);
      filler.fill(0x41);
      const filler2 = new Uint8Array(CHUNK_SIZE);
      filler2.fill(0x42);
      const filler3 = new Uint8Array(CHUNK_SIZE);
      filler3.fill(0x43);

      let pulled = 0;
      let blobsAfterFirstPull: number | undefined;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pulled === 0) {
            controller.enqueue(filler);
          } else if (pulled === 1) {
            // Snapshot blob count after the writer has consumed
            // the first source chunk but before we hand it the
            // second. With streaming this is ≥ 1; with buffering
            // it stays at 0 until end-of-stream.
            blobsAfterFirstPull = countBlobs(db);
            controller.enqueue(filler2);
          } else if (pulled === 2) {
            controller.enqueue(filler3);
          } else {
            controller.close();
          }
          pulled++;
        },
      });

      await writeFile(db, "/big.bin", stream, {}, () => 0);
      expect(blobsAfterFirstPull).toBeGreaterThanOrEqual(1);
      expect(countBlobs(db)).toBe(3);
      const back = readBack(db, "/big.bin");
      expect(back.byteLength).toBe(3 * CHUNK_SIZE);
      expect(back[0]).toBe(0x41);
      expect(back[CHUNK_SIZE]).toBe(0x42);
      expect(back[2 * CHUNK_SIZE]).toBe(0x43);
    });
  });

  it("chunks correctly when source ReadableStream chunks don't align to CHUNK_SIZE", async () => {
    await withDB(async (db) => {
      // Source emits oddly-sized parts: 100 bytes, then CHUNK_SIZE,
      // then 50 bytes. Total = CHUNK_SIZE + 150 → 2 chunks.
      const a = new Uint8Array(100);
      a.fill(0x31);
      const b = new Uint8Array(CHUNK_SIZE);
      b.fill(0x32);
      const c = new Uint8Array(50);
      c.fill(0x33);
      await writeFile(db, "/oddly.bin", streamOf(a, b, c), {}, () => 0);
      const back = readBack(db, "/oddly.bin");
      expect(back.byteLength).toBe(CHUNK_SIZE + 150);
      expect(back[0]).toBe(0x31);
      expect(back[99]).toBe(0x31);
      expect(back[100]).toBe(0x32);
      expect(back[CHUNK_SIZE + 99]).toBe(0x32);
      expect(back[CHUNK_SIZE + 100]).toBe(0x33);
      // 2 chunks (first 512KiB, then 150-byte trailing).
      const node = resolveInode(db, "/oddly.bin");
      const chunkCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_chunks WHERE inode = ?",
        node?.inode,
      );
      expect(chunkCount).toBe(2);
    });
  });
});
