import { describe, expect, it } from "vitest";

import { mkdir } from "../fs/mkdir.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import { planBlock } from "./blocks.js";
import {
  decodeChangePack,
  encodeChangePack,
  PACK_FORMAT_VERSION,
  PackProtocolError,
  readPackFooter,
} from "./change-pack.js";
import { MIN_BLOCK_PROFILE } from "./operations.js";
import { currentRev } from "./watermarks.js";

// The pack is the bulk transport: one gzip stream carrying an ordered
// run of change entries interleaved with the unique objects they
// reference, closed by a footer that identifies the cursor window and
// validates the contents.
//
// Two properties matter most. It must round-trip exactly, because the
// receiver reconstructs a filesystem from it. And a truncated or
// tampered stream must be rejected rather than half-applied, because
// the cursor would otherwise advance over data that never landed.

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function seedFiles(db: Database, count: number, bytes = 8): Promise<void> {
  for (let i = 0; i < count; i++) {
    const filler = String.fromCharCode(97 + (i % 26)).repeat(Math.max(1, bytes - 1));
    await writeFile(db, `/f${String(i).padStart(3, "0")}.txt`, `${i}${filler}`, {}, () => i + 1);
  }
}

// Encode whatever planBlock selected for the whole current window.
async function packWindow(
  db: Database,
  profile = MIN_BLOCK_PROFILE,
): Promise<{ bytes: Uint8Array; block: Awaited<ReturnType<typeof planBlock>> }> {
  const through = { rev: currentRev(db), path: null };
  const block = await planBlock(db, { after: { rev: 0, path: null }, through, profile });
  const bytes = await collect(
    encodeChangePack(db, {
      block,
      after: { rev: 0, path: null },
      target: through,
      generation: "gen-1",
    }),
  );
  return { bytes, block };
}

describe("change pack codec", () => {
  describe("round trip", () => {
    it("carries file entries and their bytes", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.entries.map((e) => e.path)).toEqual(block.entries.map((e) => e.path));
        expect(decoded.objects.size).toBe(block.objects.length);
      });
    });

    it("preserves file mode, mtime, and chunk list exactly", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/only.txt", "payload bytes", {}, () => 5);
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.entries[0]).toEqual(block.entries[0]);
      });
    });

    it("round-trips object bytes verbatim", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/only.txt", "payload bytes", {}, () => 5);
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        const hash = block.objects[0].hash;
        const key = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect(new TextDecoder().decode(decoded.objects.get(key))).toBe("payload bytes");
      });
    });

    it("carries directories, symlinks, and deletions", async () => {
      await withDB(async (db) => {
        mkdir(db, "/dir", { recursive: true }, () => 1);
        await writeFile(db, "/dir/file.txt", "content", {}, () => 2);
        symlink(db, "/dir/file.txt", "/link", () => 3);
        await writeFile(db, "/gone.txt", "bye", {}, () => 4);
        rm(db, "/gone.txt", {});
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.entries.map((e) => e.kind).sort()).toEqual(
          block.entries.map((e) => e.kind).sort(),
        );
        expect(decoded.entries.some((e) => e.kind === "delete")).toBe(true);
      });
    });

    it("stores an object shared by two paths exactly once", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/a.txt", "identical", {}, () => 1);
        await writeFile(db, "/b.txt", "identical", {}, () => 2);
        const { bytes } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.entries).toHaveLength(2);
        expect(decoded.objects.size).toBe(1);
      });
    });

    it("handles an empty block", async () => {
      await withDB(async (db) => {
        const cursor = { rev: 0, path: null };
        const block = await planBlock(db, {
          after: cursor,
          through: cursor,
          profile: MIN_BLOCK_PROFILE,
        });
        const bytes = await collect(
          encodeChangePack(db, { block, after: cursor, target: cursor, generation: "gen-1" }),
        );

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.entries).toEqual([]);
        expect(decoded.objects.size).toBe(0);
      });
    });

    it("survives a stream delivered in many small pieces", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 4, 64);
        const { bytes, block } = await packWindow(db);

        // Re-chunk byte by byte: the decoder must not assume record
        // boundaries align with transport chunks.
        const dribble = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        });
        const decoded = await decodeChangePack(dribble);

        expect(decoded.entries).toHaveLength(block.entries.length);
      });
    });
  });

  describe("footer", () => {
    it("identifies the cursor window and generation", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.footer.version).toBe(PACK_FORMAT_VERSION);
        expect(decoded.footer.generation).toBe("gen-1");
        expect(decoded.footer.after).toEqual({ rev: 0, path: null });
        expect(decoded.footer.blockCursor).toEqual(block.cursor);
        expect(decoded.footer.target).toEqual({ rev: currentRev(db), path: null });
      });
    });

    it("counts entries and objects", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const { bytes, block } = await packWindow(db);

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.footer.entryCount).toBe(block.entries.length);
        expect(decoded.footer.objectCount).toBe(block.objects.length);
      });
    });

    it("can be read without decoding the whole pack body", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const { bytes, block } = await packWindow(db);

        const footer = await readPackFooter(streamOf(bytes));

        expect(footer.blockCursor).toEqual(block.cursor);
      });
    });

    it("preserves a same-revision path in the block cursor", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 5);
        const through = { rev: currentRev(db), path: null };
        // A profile of 2 forces a partial block, so the cursor
        // carries a path rather than a bare rev.
        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through,
          profile: { maxEntries: 2, maxBytes: MIN_BLOCK_PROFILE.maxBytes },
        });
        const bytes = await collect(
          encodeChangePack(db, {
            block,
            after: { rev: 0, path: null },
            target: through,
            generation: "gen-1",
          }),
        );

        const decoded = await decodeChangePack(streamOf(bytes));

        expect(decoded.footer.blockCursor.path).toBe(block.cursor.path);
        expect(typeof decoded.footer.blockCursor.path).toBe("string");
      });
    });
  });

  describe("validation", () => {
    // A truncated pack must not apply partially. The cursor would
    // otherwise advance over entries that never arrived.
    it("rejects a truncated stream", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 4, 64);
        const { bytes } = await packWindow(db);

        const truncated = bytes.slice(0, Math.floor(bytes.byteLength / 2));

        await expect(decodeChangePack(streamOf(truncated))).rejects.toThrow(PackProtocolError);
      });
    });

    it("rejects a pack whose object bytes were tampered with", async () => {
      await withDB(async (db) => {
        await writeFile(db, "/only.txt", "payload bytes", {}, () => 5);
        const { bytes } = await packWindow(db);

        // Flip a byte in the middle of the compressed stream. Either
        // gzip or the digest must catch it; both are protocol errors.
        const tampered = new Uint8Array(bytes);
        const at = Math.floor(tampered.byteLength / 2);
        tampered[at] = tampered[at] ^ 0xff;

        await expect(decodeChangePack(streamOf(tampered))).rejects.toThrow(PackProtocolError);
      });
    });

    it("rejects an unknown format version", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 2);
        const { bytes } = await packWindow(db);

        await expect(
          decodeChangePack(streamOf(bytes), { expectVersion: PACK_FORMAT_VERSION + 1 }),
        ).rejects.toThrow(PackProtocolError);
      });
    });

    it("rejects a pack whose declared entry count disagrees with its records", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 3);
        const through = { rev: currentRev(db), path: null };
        const block = await planBlock(db, {
          after: { rev: 0, path: null },
          through,
          profile: MIN_BLOCK_PROFILE,
        });

        const bytes = await collect(
          encodeChangePack(db, {
            block,
            after: { rev: 0, path: null },
            target: through,
            generation: "gen-1",
            // Lie about the count the footer will carry.
            corruptEntryCount: 99,
          }),
        );

        await expect(decodeChangePack(streamOf(bytes))).rejects.toThrow(PackProtocolError);
      });
    });

    it("names the offending pack in the error so a protocol failure is diagnosable", async () => {
      await withDB(async (db) => {
        await seedFiles(db, 2);
        const { bytes } = await packWindow(db);
        const truncated = bytes.slice(0, 12);

        await expect(decodeChangePack(streamOf(truncated))).rejects.toThrow(/pack/i);
      });
    });
  });

  describe("compression", () => {
    it("compresses repetitive content below its raw size", async () => {
      await withDB(async (db) => {
        // Highly repetitive distinct files: each is unique so they do
        // not dedupe, but gzip should still win big.
        for (let i = 0; i < 8; i++) {
          await writeFile(db, `/f${i}.txt`, `${i}${"z".repeat(4000)}`, {}, () => i + 1);
        }
        const raw = 8 * 4001;

        const { bytes } = await packWindow(db, { maxEntries: 100, maxBytes: 64 * 1024 * 1024 });

        expect(bytes.byteLength).toBeLessThan(raw / 2);
      });
    });
  });
});
