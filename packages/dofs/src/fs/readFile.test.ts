import { describe, expect, it } from "vitest";

import { mkdir } from "./mkdir.js";
import { readFile } from "./readFile.js";
import { withDB } from "./with-db.js";
import {
  CHUNK_SIZE,
  openWriteBufferForCreateSync,
  writeFile,
  writeRangeSync,
} from "./writeFile.js";

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      parts.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("readFile", () => {
  it("returns a ReadableStream by default", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello workspace", {}, () => 0);
      const stream = await readFile(db, "/a.txt");
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(new TextDecoder().decode(await drain(stream))).toBe("hello workspace");
    });
  });

  it("returns a string when encoding is 'utf8'", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello", {}, () => 0);
      expect(await readFile(db, "/a.txt", "utf8")).toBe("hello");
    });
  });

  it("accepts the object-form encoding option", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello", {}, () => 0);
      expect(await readFile(db, "/a.txt", { encoding: "utf8" })).toBe("hello");
    });
  });

  it("streams a multi-chunk file in chunk-sized pieces", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 100);
      bytes.fill(0x41);
      for (let i = CHUNK_SIZE; i < bytes.byteLength; i++) bytes[i] = 0x42;
      await writeFile(db, "/big", bytes, {}, () => 0);

      const stream = await readFile(db, "/big");
      const reader = stream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBe(CHUNK_SIZE);
      expect(first.value?.[0]).toBe(0x41);
      const second = await reader.read();
      expect(second.done).toBe(false);
      expect(second.value?.byteLength).toBe(100);
      expect(second.value?.[0]).toBe(0x42);
      const end = await reader.read();
      expect(end.done).toBe(true);
    });
  });

  it("streams only the requested byte range across chunk boundaries", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 8);
      bytes.fill(0x41, 0, CHUNK_SIZE);
      bytes.fill(0x42, CHUNK_SIZE);
      await writeFile(db, "/big", bytes, {}, () => 0);

      const stream = await readFile(db, "/big", {
        byteOffset: CHUNK_SIZE - 4,
        byteLength: 8,
      });
      expect(Array.from(await drain(stream))).toEqual([
        0x41, 0x41, 0x41, 0x41, 0x42, 0x42, 0x42, 0x42,
      ]);
    });
  });

  it("keeps a ranged stream on the snapshot captured when it opens", async () => {
    await withDB(async (db) => {
      const original = new Uint8Array(CHUNK_SIZE + 4);
      original.fill(0x41, 0, CHUNK_SIZE);
      original.fill(0x42, CHUNK_SIZE);
      await writeFile(db, "/big", original, {}, () => 0);

      const stream = await readFile(db, "/big", {
        byteOffset: CHUNK_SIZE - 2,
        byteLength: 6,
      });
      await writeFile(db, "/big", new Uint8Array(original.byteLength).fill(0x43), {}, () => 1);

      expect(Array.from(await drain(stream))).toEqual([0x41, 0x41, 0x42, 0x42, 0x42, 0x42]);
    });
  });

  it("clamps byte ranges at EOF and supports ranged text reads", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello", {}, () => 0);

      expect(await readFile(db, "/a.txt", { encoding: "utf8", byteOffset: 1, byteLength: 3 })).toBe(
        "ell",
      );
      expect(
        (await drain(await readFile(db, "/a.txt", { byteOffset: 4, byteLength: 10 })))[0],
      ).toBe(0x6f);
      expect(await drain(await readFile(db, "/a.txt", { byteOffset: 5 }))).toHaveLength(0);
      expect(await drain(await readFile(db, "/a.txt", { byteLength: 0 }))).toHaveLength(0);
    });
  });

  it("snapshots ranged reads from pending write buffers", async () => {
    await withDB(async (db) => {
      openWriteBufferForCreateSync(db, "/pending", {}, () => 0);
      writeRangeSync(db, "/pending", new TextEncoder().encode("abcdef"), 0, {}, () => 1);

      const stream = await readFile(db, "/pending", { byteOffset: 1, byteLength: 3 });
      writeRangeSync(db, "/pending", new TextEncoder().encode("ZZZ"), 1, {}, () => 2);

      expect(new TextDecoder().decode(await drain(stream))).toBe("bcd");
    });
  });

  it("rejects invalid byte ranges", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello", {}, () => 0);
      await expect(readFile(db, "/a.txt", { byteOffset: -1 })).rejects.toMatchObject({
        code: "EINVAL",
      });
      await expect(
        readFile(db, "/a.txt", { byteLength: Number.MAX_SAFE_INTEGER + 1 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });
  });

  it("returns an empty stream for an empty file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/empty", "", {}, () => 0);
      const stream = await readFile(db, "/empty");
      const bytes = await drain(stream);
      expect(bytes.byteLength).toBe(0);
      expect(await readFile(db, "/empty", "utf8")).toBe("");
    });
  });

  it("does not modify vfs_blobs.last_seen when chunks are read", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 1);
      bytes.fill(0x61);
      await writeFile(db, "/x.txt", bytes, {}, () => 100);
      expect(db.scalar<number>("SELECT MIN(last_seen) FROM vfs_blobs")).toBe(100);

      // String form reads every chunk and must leave last_seen alone.
      await readFile(db, "/x.txt", "utf8");
      expect(db.scalar<number>("SELECT MIN(last_seen) FROM vfs_blobs")).toBe(100);

      // Stream form: drain it so every chunk is pulled, then confirm
      // no restamp happened in the pull callback.
      const stream = await readFile(db, "/x.txt");
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
      expect(db.scalar<number>("SELECT MIN(last_seen) FROM vfs_blobs")).toBe(100);
    });
  });

  it("rejects ENOENT when the path does not exist", async () => {
    await withDB(async (db) => {
      await expect(readFile(db, "/missing")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(db, "/missing", "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects EISDIR when the path is a directory", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await expect(readFile(db, "/d")).rejects.toMatchObject({ code: "EISDIR" });
      await expect(readFile(db, "/d", "utf8")).rejects.toMatchObject({ code: "EISDIR" });
    });
  });

  it("rejects ENOENT when an intermediate segment is missing", async () => {
    await withDB(async (db) => {
      await expect(readFile(db, "/no/such/file")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
