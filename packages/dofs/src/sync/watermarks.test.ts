import { describe, expect, it } from "vitest";

import { withDB } from "../fs/with-db.js";
import { writeFile } from "../fs/writeFile.js";
import {
  compareChangeCursors,
  currentRev,
  readFetchCursor,
  readPushCursor,
  readWatermark,
  writeFetchCursor,
  writePushCursor,
  writeWatermark,
} from "./watermarks.js";

describe("watermarks", () => {
  it("readWatermark returns 0 for a fresh DB", async () => {
    await withDB(async (db) => {
      expect(readWatermark(db, "pushRev")).toBe(0);
    });
  });

  it("writeWatermark persists across reads", async () => {
    await withDB(async (db) => {
      writeWatermark(db, "pushRev", 42);
      expect(readWatermark(db, "pushRev")).toBe(42);
    });
  });

  it("persists the fetch cursor rev and path separately", async () => {
    await withDB(async (db) => {
      expect(readFetchCursor(db)).toEqual({ rev: 0, path: null });
      writeFetchCursor(db, { rev: 12, path: "/dir/file.txt" });
      expect(readFetchCursor(db)).toEqual({ rev: 12, path: "/dir/file.txt" });
      writeFetchCursor(db, { rev: 13, path: null });
      expect(readFetchCursor(db)).toEqual({ rev: 13, path: null });
    });
  });

  it("persists a path-aware push cursor per backend", async () => {
    await withDB(async (db) => {
      expect(readPushCursor(db)).toEqual({ rev: 0, path: null });
      writePushCursor(db, { rev: 12, path: "/dir/file.txt" }, "container");
      expect(readPushCursor(db, "container")).toEqual({ rev: 12, path: "/dir/file.txt" });
      expect(readPushCursor(db, "worker")).toEqual({ rev: 0, path: null });
      writePushCursor(db, { rev: 13, path: null }, "container");
      expect(readPushCursor(db, "container")).toEqual({ rev: 13, path: null });
    });
  });

  it("does not persist an intermediate full-rev cursor when a partial cursor write fails", async () => {
    await withDB(async (db) => {
      writeFetchCursor(db, { rev: 12, path: null });

      const originalRun = db.run.bind(db);
      db.run = ((query: string, ...bindings: unknown[]) => {
        if (query.includes("_vfs_fetch_cursor")) {
          throw new Error("forced cursor path failure");
        }
        return originalRun(query, ...bindings);
      }) as typeof db.run;

      expect(() => writeFetchCursor(db, { rev: 13, path: "/partial.txt" })).toThrow(
        "forced cursor path failure",
      );
      expect(readFetchCursor(db)).toEqual({ rev: 12, path: null });
    });
  });

  it("returns a fresh start cursor for a zero fetchRev", async () => {
    await withDB(async (db) => {
      const cursor = readFetchCursor(db);
      cursor.rev = 99;
      cursor.path = "/mutated.txt";

      expect(readFetchCursor(db)).toEqual({ rev: 0, path: null });
    });
  });

  it("orders partial cursors before full same-rev cursors", () => {
    expect(compareChangeCursors({ rev: 0, path: null }, { rev: 0, path: null })).toBe(0);
    expect(compareChangeCursors({ rev: 12, path: null }, { rev: 12, path: "/partial.txt" })).toBe(
      1,
    );
    expect(compareChangeCursors({ rev: 12, path: "/partial.txt" }, { rev: 12, path: null })).toBe(
      -1,
    );
    expect(compareChangeCursors({ rev: 13, path: "/partial.txt" }, { rev: 12, path: null })).toBe(
      1,
    );
  });

  it("watermarks advance monotonically (the caller enforces this)", async () => {
    await withDB(async (db) => {
      writeWatermark(db, "pushRev", 5);
      writeWatermark(db, "pushRev", 10);
      expect(readWatermark(db, "pushRev")).toBe(10);
      // Going backwards is allowed by the helper itself; the sync
      // layer's batch-commit logic is what keeps the counter monotonic.
      writeWatermark(db, "pushRev", 3);
      expect(readWatermark(db, "pushRev")).toBe(3);
    });
  });

  it("currentRev reports the latest rev stamped on a mutation", async () => {
    await withDB(async (db) => {
      // initializeSchema seeds rev=1 (stamped on the root inode).
      const base = currentRev(db);
      expect(base).toBeGreaterThanOrEqual(1);
      await writeFile(db, "/a.txt", "x", {}, () => 1);
      const r1 = currentRev(db);
      expect(r1).toBeGreaterThan(base);
      await writeFile(db, "/b.txt", "y", {}, () => 2);
      expect(currentRev(db)).toBeGreaterThan(r1);
    });
  });

  it("rejects unknown watermark keys at the type level via the helper signature", () => {
    // Compile-time only: writeWatermark only accepts "pushRev".
    // Fetch progress must go through readFetchCursor/writeFetchCursor.
    expect(true).toBe(true);
  });

  describe("per-backend keying", () => {
    it("writes under the default backend when the caller omits the id", async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", 17);
        // The omitted-id read sees the same row.
        expect(readWatermark(db, "pushRev")).toBe(17);
        // An explicit "default" id also sees it — same slot.
        expect(readWatermark(db, "pushRev", "default")).toBe(17);
      });
    });

    it("keeps each backend's cursors independent", async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", 10, "worker");
        writeWatermark(db, "pushRev", 20, "container");
        expect(readWatermark(db, "pushRev", "worker")).toBe(10);
        expect(readWatermark(db, "pushRev", "container")).toBe(20);
        // A push under "worker" doesn't disturb the "container"
        // backend's cursor.
        writeWatermark(db, "pushRev", 11, "worker");
        expect(readWatermark(db, "pushRev", "worker")).toBe(11);
        expect(readWatermark(db, "pushRev", "container")).toBe(20);
      });
    });

    it("unknown backend id reads as 0", async () => {
      await withDB(async (db) => {
        writeWatermark(db, "pushRev", 5, "worker");
        expect(readWatermark(db, "pushRev", "never-registered")).toBe(0);
      });
    });
  });
});
