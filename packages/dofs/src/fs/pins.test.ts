import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../storage";
import { hasObjects } from "../sync/fetch";
import { HAS_OBJECTS_PIN_MS, isPinned, pinHashes, STREAM_IDLE_LEASE_MS } from "./pins";
import { readFile } from "./readFile";
import { withDB } from "./with-db";
import { CHUNK_SIZE, writeFile } from "./writeFile";

const MINUTE = 60 * 1000;

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function hashOf(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function chunkHashes(db: Database, path: string): Uint8Array[] {
  return db
    .all<{ hash: Uint8Array }>(
      `SELECT c.hash AS hash FROM vfs_chunks c
         JOIN vfs_dirents d ON d.child_inode = c.inode
        WHERE d.parent_inode = 1 AND d.name = ?
        ORDER BY c.idx`,
      path.slice(1),
    )
    .map((row) => row.hash);
}

// Pins expire on the wall clock. Fake only Date so streams and promises
// keep running for real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pin registry", () => {
  it("pins a hash until the pin is released", async () => {
    await withDB((db) => {
      expect(isPinned(db, hashOf(1))).toBe(false);
      const pin = pinHashes(db, [hashOf(1)]);
      expect(isPinned(db, hashOf(1))).toBe(true);
      expect(isPinned(db, hashOf(2))).toBe(false);
      pin.release();
      expect(isPinned(db, hashOf(1))).toBe(false);
    });
  });

  it("keeps a hash pinned while any holder remains", async () => {
    await withDB((db) => {
      const first = pinHashes(db, [hashOf(1)]);
      const second = pinHashes(db, [hashOf(1)]);
      first.release();
      expect(isPinned(db, hashOf(1))).toBe(true);
      second.release();
      expect(isPinned(db, hashOf(1))).toBe(false);
    });
  });

  it("adds hashes to a pin after it was taken", async () => {
    await withDB((db) => {
      const pin = pinHashes(db, []);
      pin.add(hashOf(3));
      expect(isPinned(db, hashOf(3))).toBe(true);
      pin.release();
      expect(isPinned(db, hashOf(3))).toBe(false);
    });
  });

  it("keeps pins separate per database", async () => {
    await withDB(async (a) => {
      await withDB((b) => {
        pinHashes(a, [hashOf(1)]);
        expect(isPinned(b, hashOf(1))).toBe(false);
      });
    });
  });

  it("lets a leased pin lapse when nobody renews it", async () => {
    await withDB((db) => {
      pinHashes(db, [hashOf(1)], { leaseMs: MINUTE });
      vi.advanceTimersByTime(MINUTE - 1);
      expect(isPinned(db, hashOf(1))).toBe(true);
      vi.advanceTimersByTime(1);
      expect(isPinned(db, hashOf(1))).toBe(false);
    });
  });

  it("extends a leased pin on renew, even after it lapsed", async () => {
    await withDB((db) => {
      const pin = pinHashes(db, [hashOf(1)], { leaseMs: MINUTE });
      vi.advanceTimersByTime(MINUTE / 2);
      pin.renew();
      vi.advanceTimersByTime(MINUTE - 1);
      expect(isPinned(db, hashOf(1))).toBe(true);
      vi.advanceTimersByTime(MINUTE);
      expect(isPinned(db, hashOf(1))).toBe(false);
      pin.renew();
      expect(isPinned(db, hashOf(1))).toBe(true);
    });
  });
});

describe("lazy readFile stream pins", () => {
  it("pins the chunks it captured until it is drained", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 10).fill(7);
      bytes[CHUNK_SIZE] = 8;
      await writeFile(db, "/big.bin", bytes, {}, () => 0);
      const hashes = chunkHashes(db, "/big.bin");
      expect(hashes).toHaveLength(2);

      const stream = await readFile(db, "/big.bin");
      expect(hashes.every((hash) => isPinned(db, hash))).toBe(true);

      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain
      }
      expect(hashes.some((hash) => isPinned(db, hash))).toBe(false);
    });
  });

  it("releases its pins when cancelled", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "cancel me", {}, () => 0);
      const [hash] = chunkHashes(db, "/a.txt");
      const stream = await readFile(db, "/a.txt");
      expect(isPinned(db, hash)).toBe(true);
      await stream.cancel();
      expect(isPinned(db, hash)).toBe(false);
    });
  });

  it("releases a stream dropped without cancelling after the idle lease", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(3 * CHUNK_SIZE).fill(1);
      bytes[CHUNK_SIZE] = 2;
      bytes[2 * CHUNK_SIZE] = 3;
      await writeFile(db, "/big.bin", bytes, {}, () => 0);
      const hashes = chunkHashes(db, "/big.bin");

      const reader = (await readFile(db, "/big.bin")).getReader();
      vi.advanceTimersByTime(STREAM_IDLE_LEASE_MS - 1);
      // Reading renews the lease. Two reads make the stream fetch the
      // second chunk now, whether the runtime refills its queue right
      // after a read (node) or on the next one (workerd).
      await reader.read();
      await reader.read();
      vi.advanceTimersByTime(STREAM_IDLE_LEASE_MS - 1);
      expect(isPinned(db, hashes[2])).toBe(true);
      // Then the caller walks away without cancelling.
      vi.advanceTimersByTime(1);
      expect(isPinned(db, hashes[2])).toBe(false);
    });
  });

  it("does not pin for a string read", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "plain", {}, () => 0);
      const [hash] = chunkHashes(db, "/a.txt");
      expect(await readFile(db, "/a.txt", "utf8")).toBe("plain");
      expect(isPinned(db, hash)).toBe(false);
    });
  });
});

describe("streaming writeFile pins", () => {
  it("pins each staged chunk until the file links them", async () => {
    await withDB(async (db) => {
      const first = new Uint8Array(CHUNK_SIZE).fill(3);
      const firstHash = sha256(first);
      let pinnedWhileStreaming: boolean | undefined;
      let sent = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) {
            controller.enqueue(first);
          } else if (sent === 1) {
            // The first window is staged, but nothing links it yet.
            pinnedWhileStreaming = isPinned(db, firstHash);
            controller.enqueue(new Uint8Array([1, 2, 3]));
          } else {
            controller.close();
          }
          sent++;
        },
      });

      await writeFile(db, "/streamed.bin", source, {}, () => 0);

      expect(pinnedWhileStreaming).toBe(true);
      expect(isPinned(db, firstHash)).toBe(false);
    });
  });

  it("releases its pins when the source fails", async () => {
    await withDB(async (db) => {
      const first = new Uint8Array(CHUNK_SIZE).fill(4);
      let sent = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ === 0) {
            controller.enqueue(first);
            return;
          }
          controller.error(new Error("source broke"));
        },
      });

      await expect(writeFile(db, "/broken.bin", source, {}, () => 0)).rejects.toThrow(
        "source broke",
      );
      expect(isPinned(db, sha256(first))).toBe(false);
    });
  });
});

describe("hasObjects pins", () => {
  it("pins what it reports present for a while, and nothing it reports missing", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "present", {}, () => 0);
      const [present] = chunkHashes(db, "/a.txt");
      const missing = hashOf(9);

      expect(hasObjects(db, [present, missing])).toEqual([present]);
      expect(isPinned(db, present)).toBe(true);
      expect(isPinned(db, missing)).toBe(false);

      vi.advanceTimersByTime(HAS_OBJECTS_PIN_MS - 1);
      expect(isPinned(db, present)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(isPinned(db, present)).toBe(false);
    });
  });
});
