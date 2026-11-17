import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Database } from "../storage";
import { applyChangesSync } from "../sync/apply";
import type { ChangeEntry } from "../sync/changes";
import { gc } from "./gc";
import { readFile } from "./readFile";
import { dropChunks } from "./refs";
import { resolveInode } from "./resolve";
import { withDB } from "./with-db";
import { writeFileSync } from "./writeFile";

// Reaping inside nested transactions. A nested transactionSync is a
// SAVEPOINT, which Durable Object storage rejects, so the workers config
// leaves this file out and it runs under node only.

const NOW = (): number => 1000;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function orphansLeft(db: Database): { blobsFreed: number; manifestsFreed: number } {
  return gc(db, { safetyWindowMs: 0, now: () => Number.MAX_SAFE_INTEGER });
}

describe("reaping in nested transactions", () => {
  it("applies a rename with applyChangesSync inside an outer transaction", async () => {
    await withDB(async (db) => {
      // The push receiver's shape: one outer transaction around the
      // whole block, so every entry's work commits together.
      const moved = encode("moved under one transaction");
      writeFileSync(db, "/old.txt", moved, {}, NOW);
      const entries: ChangeEntry[] = [
        { kind: "delete", rev: 2, path: "/old.txt" },
        {
          kind: "file",
          rev: 2,
          path: "/new.txt",
          mode: 0o644,
          mtime: 1,
          size: moved.byteLength,
          chunks: [{ hash: sha256(moved), size: moved.byteLength }],
        },
      ];

      db.transactionSync(() => {
        applyChangesSync(db, entries, new Map());
      });

      expect(await readFile(db, "/new.txt", "utf8")).toBe("moved under one transaction");
      expect(resolveInode(db, "/old.txt")).toBeNull();
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs")).toBe(1);
      expect(orphansLeft(db)).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
    });
  });

  it("keeps content whose drop a savepoint rolled back", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/a.txt", encode("survives the savepoint"), {}, NOW);
      const inode = resolveInode(db, "/a.txt")?.inode ?? 0;

      db.transactionSync(() => {
        try {
          db.transactionSync(() => {
            dropChunks(db, inode);
            throw new Error("roll back the savepoint");
          });
        } catch {
          // The outer transaction carries on and commits. The dropped
          // hash is still recorded, and the reference probe at commit
          // finds the chunk row the savepoint put back.
        }
      });

      expect(await readFile(db, "/a.txt", "utf8")).toBe("survives the savepoint");
      expect(orphansLeft(db)).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
    });
  });
});
