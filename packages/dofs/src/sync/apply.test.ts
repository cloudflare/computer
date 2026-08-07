import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { link } from "../fs/link.js";
import { mkdir } from "../fs/mkdir.js";
import { invalidateReadOnlyMountCache } from "../fs/mount-guard.js";
import { readFile } from "../fs/readFile.js";
import { readlink } from "../fs/readlink.js";
import { rename } from "../fs/rename.js";
import { resolveInode } from "../fs/resolve.js";
import { rm } from "../fs/rm.js";
import { symlink } from "../fs/symlink.js";
import { withDB, withTwoDBs } from "../fs/with-db.js";
import { CHUNK_SIZE, writeFile, writeFileSync } from "../fs/writeFile.js";
import { applyChanges, applyChangesSync } from "./apply.js";
import { stageBlob } from "./blobs.js";
import type { ChangeEntry } from "./changes.js";
import { coalesceChanges } from "./coalesce.js";
import { fetchObjects } from "./fetch.js";
import { currentRev } from "./watermarks.js";

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function deepChildPath(depth: number): string {
  return `/dst/${Array.from({ length: depth }, () => "d").join("/")}/old.txt`;
}

async function collectObjects(
  db: import("../storage.js").Database,
  entries: ChangeEntry[],
): Promise<Map<string, Uint8Array>> {
  const hashes: Uint8Array[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "file") continue;
    for (const c of e.chunks) {
      const k = hex(c.hash);
      if (!seen.has(k)) {
        seen.add(k);
        hashes.push(c.hash);
      }
    }
  }
  const out = new Map<string, Uint8Array>();
  for await (const { hash, bytes } of fetchObjects(db, hashes)) {
    out.set(hex(hash), bytes);
  }
  return out;
}

describe("applyChanges", () => {
  it("converges across a mixed stream", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/a.txt", "alpha", {}, () => 1);
        await writeFile(a, "/b.txt", "beta", {}, () => 2);
        const entries = await drain(coalesceChanges(a, 0));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await applyChanges(b, entries, objects);
        expect(await readFile(b, "/a.txt", "utf8")).toBe("alpha");
        expect(await readFile(b, "/b.txt", "utf8")).toBe("beta");
      },
    );
  });

  it("links staged chunks without reading payload bytes", async () => {
    const content = `${"a".repeat(CHUNK_SIZE)}b`;
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/large.txt", content, {}, () => 1);
        const entries = await drain(coalesceChanges(a, 0));
        const entry = entries.find((candidate) => candidate.path === "/large.txt");
        if (entry?.kind !== "file") throw new Error("missing file entry");
        expect(entry.chunks).toHaveLength(2);
        return { entry, objects: await collectObjects(a, [entry]) };
      },
      async (b, { entry, objects }) => {
        for (const chunk of entry.chunks) {
          const bytes = objects.get(hex(chunk.hash));
          if (bytes === undefined) throw new Error("missing chunk bytes");
          stageBlob(b, chunk.hash, bytes, 2);
        }

        const all = vi.spyOn(b, "all");
        try {
          await applyChanges(b, [entry], new Map(), { source: "upstream" });
          const payloadReads = all.mock.calls.filter(([query]) =>
            query.includes("SELECT bytes FROM vfs_blob_bytes"),
          );
          expect(all.mock.calls.length).toBeGreaterThan(0);
          expect(payloadReads).toHaveLength(0);
        } finally {
          all.mockRestore();
        }
        expect(await readFile(b, "/large.txt", "utf8")).toBe(content);
      },
    );
  });

  it("links staged chunks synchronously without reading payload bytes", async () => {
    const content = `${"a".repeat(CHUNK_SIZE)}b`;
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/large.txt", content, {}, () => 1);
        const entries = await drain(coalesceChanges(a, 0));
        const entry = entries.find((candidate) => candidate.path === "/large.txt");
        if (entry?.kind !== "file") throw new Error("missing file entry");
        expect(entry.chunks).toHaveLength(2);
        return { entry, objects: await collectObjects(a, [entry]) };
      },
      async (b, { entry, objects }) => {
        for (const chunk of entry.chunks) {
          const bytes = objects.get(hex(chunk.hash));
          if (bytes === undefined) throw new Error("missing chunk bytes");
          stageBlob(b, chunk.hash, bytes, 2);
        }

        const all = vi.spyOn(b, "all");
        try {
          applyChangesSync(b, [entry], new Map(), { source: "upstream" });
          const payloadReads = all.mock.calls.filter(([query]) =>
            query.includes("SELECT bytes FROM vfs_blob_bytes"),
          );
          expect(all.mock.calls.length).toBeGreaterThan(0);
          expect(payloadReads).toHaveLength(0);
        } finally {
          all.mockRestore();
        }
        expect(await readFile(b, "/large.txt", "utf8")).toBe(content);
      },
    );
  });

  it("rejects a file entry whose interior chunks are not chunk-aligned", async () => {
    // Positional reads locate a chunk by dividing the offset by
    // CHUNK_SIZE, so only the final chunk may be short. Linking a
    // sender's chunk list verbatim has to enforce that.
    await withDB(async (db) => {
      const first = new TextEncoder().encode("first");
      const second = new TextEncoder().encode("second");
      const chunks = [first, second].map((bytes) => {
        const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
        stageBlob(db, hash, bytes, 1000);
        return { hash, size: bytes.byteLength };
      });

      await expect(
        applyChanges(
          db,
          [
            {
              kind: "file",
              rev: 1,
              path: "/ragged.txt",
              mode: 0o644,
              mtime: 1000,
              size: first.byteLength + second.byteLength,
              chunks,
            },
          ],
          new Map(),
          { source: "upstream" },
        ),
      ).rejects.toThrow(/chunk/);
      expect(resolveInode(db, "/ragged.txt")).toBeNull();
    });
  });

  it("leaves the existing file in place when it rejects a ragged entry", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/keep.txt", "original", {}, () => 1000);

      const first = new TextEncoder().encode("first");
      const second = new TextEncoder().encode("second");
      const chunks = [first, second].map((bytes) => {
        const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
        stageBlob(db, hash, bytes, 1000);
        return { hash, size: bytes.byteLength };
      });

      await expect(
        applyChanges(
          db,
          [
            {
              kind: "file",
              rev: 2,
              path: "/keep.txt",
              mode: 0o644,
              mtime: 2000,
              size: first.byteLength + second.byteLength,
              chunks,
            },
          ],
          new Map(),
          { source: "upstream" },
        ),
      ).rejects.toThrow(/chunk/);
      expect(await readFile(db, "/keep.txt", "utf8")).toBe("original");
    });
  });

  it("rejects a file entry with a chunk larger than the chunk size", async () => {
    await withDB(async (db) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 1);
      const hash = new Uint8Array(createHash("sha256").update(bytes).digest());
      stageBlob(db, hash, bytes, 1000);

      await expect(
        applyChanges(
          db,
          [
            {
              kind: "file",
              rev: 1,
              path: "/oversized.bin",
              mode: 0o644,
              mtime: 1000,
              size: bytes.byteLength,
              chunks: [{ hash, size: bytes.byteLength }],
            },
          ],
          new Map(),
          { source: "upstream" },
        ),
      ).rejects.toThrow(/chunk/);
      expect(resolveInode(db, "/oversized.bin")).toBeNull();
    });
  });

  it("commits in batches capped by byte budget", async () => {
    // Force many small files; with a tiny byte budget the apply
    // path should still converge, just across more batches. We
    // verify convergence rather than batch count (batch count is
    // an implementation detail).
    await withTwoDBs(
      async (a) => {
        for (let i = 0; i < 10; i++) {
          await writeFile(a, `/f${i}.txt`, `payload ${i}`, {}, () => 100 + i);
        }
        const entries = await drain(coalesceChanges(a, 0));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await applyChanges(b, entries, objects, { maxBytesPerBatch: 16 });
        for (let i = 0; i < 10; i++) {
          expect(await readFile(b, `/f${i}.txt`, "utf8")).toBe(`payload ${i}`);
        }
      },
    );
  });

  it("applies a file rename over an existing file", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/src", "new", {}, () => 1);
        await writeFile(a, "/dst", "old", {}, () => 2);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/src", "new", {}, () => 1);
        await writeFile(b, "/dst", "old", {}, () => 2);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src")).toBeNull();
        expect(await readFile(b, "/dst", "utf8")).toBe("new");
      },
    );
  });

  it("applies a directory rename over an existing empty directory", async () => {
    await withTwoDBs(
      async (a) => {
        mkdir(a, "/src", { mode: 0o700, recursive: true }, () => 1);
        await writeFile(a, "/src/inside", "x", {}, () => 2);
        mkdir(a, "/dst", { mode: 0o755 }, () => 3);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        mkdir(b, "/src", { mode: 0o700, recursive: true }, () => 1);
        await writeFile(b, "/src/inside", "x", {}, () => 2);
        mkdir(b, "/dst", { mode: 0o755 }, () => 3);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src")).toBeNull();
        expect(resolveInode(b, "/dst", { followSymlinks: false })).toMatchObject({
          type: "dir",
          mode: 0o700,
          mtime: 1,
        });
        expect(await readFile(b, "/dst/inside", "utf8")).toBe("x");
      },
    );
  });

  it("applyChangesSync updates existing directory metadata", async () => {
    await withDB((db) => {
      mkdir(db, "/dst", { mode: 0o755 }, () => 3);

      applyChangesSync(
        db,
        [{ kind: "dir", rev: 99, path: "/dst", mode: 0o700, mtime: 1 }],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })).toMatchObject({
        type: "dir",
        mode: 0o700,
        mtime: 1,
      });
    });
  });

  it("does not update existing directory mtime for upstream entries with matching mode", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dst", { mode: 0o700 }, () => 3);

      await applyChanges(
        db,
        [{ kind: "dir", rev: 99, path: "/dst", mode: 0o700, mtime: 1 }],
        new Map(),
        { source: "upstream" },
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })).toMatchObject({
        type: "dir",
        mode: 0o700,
        mtime: 3,
      });
    });
  });

  it("applies a file rename over an existing symlink", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/target", "target", {}, () => 1);
        await writeFile(a, "/src", "new", {}, () => 2);
        symlink(a, "/target", "/dst", () => 3);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/target", "target", {}, () => 1);
        await writeFile(b, "/src", "new", {}, () => 2);
        symlink(b, "/target", "/dst", () => 3);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src")).toBeNull();
        expect(resolveInode(b, "/dst", { followSymlinks: false })?.type).toBe("file");
        expect(await readFile(b, "/dst", "utf8")).toBe("new");
        expect(await readFile(b, "/target", "utf8")).toBe("target");
      },
    );
  });

  it("applies a symlink rename over an existing file", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/target", "target", {}, () => 1);
        symlink(a, "/target", "/src", () => 2);
        await writeFile(a, "/dst", "old", {}, () => 3);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/target", "target", {}, () => 1);
        symlink(b, "/target", "/src", () => 2);
        await writeFile(b, "/dst", "old", {}, () => 3);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src", { followSymlinks: false })).toBeNull();
        expect(resolveInode(b, "/dst", { followSymlinks: false })?.type).toBe("symlink");
        expect(readlink(b, "/dst")).toBe("/target");
        expect(await readFile(b, "/target", "utf8")).toBe("target");
      },
    );
  });

  it("applies a symlink rename over an existing symlink", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/target", "target", {}, () => 1);
        await writeFile(a, "/other", "other", {}, () => 2);
        symlink(a, "/target", "/src", () => 3);
        symlink(a, "/other", "/dst", () => 4);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/target", "target", {}, () => 1);
        await writeFile(b, "/other", "other", {}, () => 2);
        symlink(b, "/target", "/src", () => 3);
        symlink(b, "/other", "/dst", () => 4);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src", { followSymlinks: false })).toBeNull();
        expect(resolveInode(b, "/dst", { followSymlinks: false })?.type).toBe("symlink");
        expect(readlink(b, "/dst")).toBe("/target");
        expect(await readFile(b, "/target", "utf8")).toBe("target");
        expect(await readFile(b, "/other", "utf8")).toBe("other");
      },
    );
  });

  it("applies a directory rename containing a symlink without deleting its target", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/target", "target", {}, () => 1);
        mkdir(a, "/src", {}, () => 2);
        symlink(a, "/target", "/src/link", () => 3);
        const cursor = currentRev(a);

        rename(a, "/src", "/dst");

        const entries = await drain(coalesceChanges(a, cursor));
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/target", "target", {}, () => 1);
        mkdir(b, "/src", {}, () => 2);
        symlink(b, "/target", "/src/link", () => 3);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/src/link", { followSymlinks: false })).toBeNull();
        expect(resolveInode(b, "/dst/link", { followSymlinks: false })?.type).toBe("symlink");
        expect(readlink(b, "/dst/link")).toBe("/target");
        expect(await readFile(b, "/target", "utf8")).toBe("target");
      },
    );
  });

  it("applies a file over an existing directory subtree", async () => {
    await withDB(async (db) => {
      mkdir(db, "/dst/sub", { recursive: true }, () => 1);
      await writeFile(db, "/dst/sub/old.txt", "old", {}, () => 2);

      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 99,
            path: "/dst",
            mode: 0o644,
            mtime: 3,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("file");
      expect(resolveInode(db, "/dst/sub/old.txt")).toBeNull();
    });
  });

  it("applies a file over a deeply nested existing directory subtree", async () => {
    await withDB(async (db) => {
      const oldPath = deepChildPath(12_000);
      mkdir(db, oldPath.slice(0, -"/old.txt".length), { recursive: true }, () => 1);
      await writeFile(db, oldPath, "old", {}, () => 2);

      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 99,
            path: "/dst",
            mode: 0o644,
            mtime: 3,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("file");
      expect(resolveInode(db, oldPath, { followSymlinks: false })).toBeNull();
    });
  });

  it("applies a symlink over an existing directory subtree", async () => {
    await withDB((db) => {
      mkdir(db, "/dst/sub", { recursive: true }, () => 1);
      writeFileSync(db, "/dst/sub/old.txt", new Uint8Array(), {}, () => 2);

      applyChangesSync(
        db,
        [
          {
            kind: "symlink",
            rev: 99,
            path: "/dst",
            mode: 0o777,
            mtime: 3,
            target: "/target",
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("symlink");
      expect(readlink(db, "/dst")).toBe("/target");
      expect(resolveInode(db, "/dst/sub/old.txt")).toBeNull();
    });
  });

  it("applies a symlink over one hardlink without removing sibling hardlinks", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/dst", "shared", {}, () => 1);
      link(db, "/dst", "/other");

      await applyChanges(
        db,
        [
          {
            kind: "symlink",
            rev: 99,
            path: "/dst",
            mode: 0o777,
            mtime: 2,
            target: "/target",
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("symlink");
      expect(readlink(db, "/dst")).toBe("/target");
      expect(await readFile(db, "/other", "utf8")).toBe("shared");
    });
  });

  it("applies a directory over one hardlink without removing sibling hardlinks", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/dst", "shared", {}, () => 1);
      link(db, "/dst", "/other");

      await applyChanges(
        db,
        [{ kind: "dir", rev: 99, path: "/dst", mode: 0o755, mtime: 2 }],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("dir");
      expect(await readFile(db, "/other", "utf8")).toBe("shared");
    });
  });

  it("applies a file over a directory whose subtree hardlinks a file outside it", async () => {
    await withDB(async (db) => {
      await mkdir(db, "/dir", { mode: 0o755 }, () => 1);
      await writeFile(db, "/dir/inner", "shared", {}, () => 1);
      // /outside is a second name for /dir/inner; replacing /dir must
      // walk the subtree by name and keep /outside alive.
      link(db, "/dir/inner", "/outside");

      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 99,
            path: "/dir",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dir", { followSymlinks: false })?.type).toBe("file");
      expect(resolveInode(db, "/dir/inner", { followSymlinks: false })).toBeNull();
      expect(await readFile(db, "/outside", "utf8")).toBe("shared");
    });
  });

  it("applyChangesSync applies a symlink over a deeply nested existing directory subtree", async () => {
    await withDB((db) => {
      const oldPath = deepChildPath(12_000);
      mkdir(db, oldPath.slice(0, -"/old.txt".length), { recursive: true }, () => 1);
      writeFileSync(db, oldPath, new Uint8Array(), {}, () => 2);

      applyChangesSync(
        db,
        [
          {
            kind: "symlink",
            rev: 99,
            path: "/dst",
            mode: 0o777,
            mtime: 3,
            target: "/target",
          },
        ],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })?.type).toBe("symlink");
      expect(readlink(db, "/dst")).toBe("/target");
      expect(resolveInode(db, oldPath, { followSymlinks: false })).toBeNull();
    });
  });

  it("applies a directory over an existing file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/dst", "old", {}, () => 1);

      await applyChanges(
        db,
        [{ kind: "dir", rev: 99, path: "/dst", mode: 0o755, mtime: 2 }],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })).toMatchObject({
        type: "dir",
        mode: 0o755,
        mtime: 2,
      });
    });
  });

  it("applies a directory over an existing symlink", async () => {
    await withDB((db) => {
      symlink(db, "/target", "/dst", () => 1);

      applyChangesSync(
        db,
        [{ kind: "dir", rev: 99, path: "/dst", mode: 0o755, mtime: 2 }],
        new Map(),
      );

      expect(resolveInode(db, "/dst", { followSymlinks: false })).toMatchObject({
        type: "dir",
        mode: 0o755,
        mtime: 2,
      });
    });
  });

  it("applies a coalesced file-to-directory replacement", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/dst", "old", {}, () => 1);
        const cursor = currentRev(a);
        rm(a, "/dst", { force: true });
        mkdir(a, "/dst", {}, () => 2);
        const entries = await drain(coalesceChanges(a, cursor));
        expect(entries).toEqual([expect.objectContaining({ kind: "dir", path: "/dst" })]);
        return { entries, objects: await collectObjects(a, entries) };
      },
      async (b, { entries, objects }) => {
        await writeFile(b, "/dst", "old", {}, () => 1);

        await applyChanges(b, entries, objects);

        expect(resolveInode(b, "/dst", { followSymlinks: false })?.type).toBe("dir");
      },
    );
  });

  it("handles delete entries", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/gone.txt", "bye", {}, () => 1);
      await applyChanges(db, [{ kind: "delete", rev: 99, path: "/gone.txt" }], new Map());
      expect(resolveInode(db, "/gone.txt")).toBeNull();
    });
  });
});

describe("applyChanges loopback suppression", () => {
  it("does not advance pushRev locally on upstream apply", async () => {
    await withDB(async (db) => {
      // Pre-existing local state: a write the container already
      // pushed. pushRev sits at currentRev.
      await writeFile(db, "/local.txt", "local", {}, () => 1);
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      writeWatermark(db, "pushRev", currentRev(db));
      const beforePushRev = readWatermark(db, "pushRev");
      expect(beforePushRev).toBeGreaterThan(0);

      // Apply an entry as if it came from upstream. The apply's
      // writeFile bumps the local rev counter, but pushRev must
      // *not* advance with it — advancing locally would move our
      // pushRev past entries the remote does not know we have
      // shipped, breaking the cross-side invariant on the next
      // pull. The next pushOnce re-ships these rev bumps and the
      // receiver's alreadyApplied() check drops them.
      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );

      const afterCurrent = currentRev(db);
      const afterPushRev = readWatermark(db, "pushRev");
      expect(afterCurrent).toBeGreaterThan(beforePushRev);
      expect(afterPushRev).toBe(beforePushRev);
    });
  });

  it("source=local (default) does not advance pushRev", async () => {
    await withDB(async (db) => {
      const { readWatermark } = await import("./watermarks.js");
      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/local.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );
      expect(readWatermark(db, "pushRev")).toBe(0);
    });
  });

  it("upstream entries surface on the next coalesce and rely on receiver-side alreadyApplied", async () => {
    await withDB(async (db) => {
      const { coalesceChanges } = await import("./coalesce.js");
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      // Seed pushRev at the current point.
      writeWatermark(db, "pushRev", currentRev(db));

      // Upstream sends a file. After apply, pushRev stays where it
      // was (the local advance was unsound — see the test above).
      // The next coalesceChanges(db, pushRev) re-emits the entry;
      // the receiver's alreadyApplied() check drops it. One extra
      // round trip per apply, watermarks stay in lockstep.
      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/upstream.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      const cursor = readWatermark(db, "pushRev");
      const drained = [];
      for await (const e of coalesceChanges(db, cursor)) drained.push(e);
      expect(drained.map((e) => e.path)).toContain("/upstream.txt");
    });
  });
});

describe("applyChanges loopback suppression — F1", () => {
  // Regression for F1: when local writes are sitting at
  // rev > pushRev (i.e. queued for the next push) and an
  // upstream pull arrives, the old code advanced pushRev to
  // currentRev unconditionally. That stranded the local
  // writes — the next pushOnce skipped them as already-
  // shipped. Fix: only advance pushRev when the existing
  // value already covers everything that existed before this
  // apply.
  it("does not advance pushRev past unpushed local writes", async () => {
    await withDB(async (db) => {
      const { currentRev, readWatermark } = await import("./watermarks.js");
      // Simulate an unpushed local write: pushRev stays at
      // its initial value (1) but currentRev climbs.
      await writeFile(db, "/local.txt", new Uint8Array([1, 2, 3]), { mode: 0o644 }, () => 1);
      const revBeforeApply = currentRev(db);
      const pushRevBefore = readWatermark(db, "pushRev");
      expect(pushRevBefore).toBeLessThan(revBeforeApply);

      // Upstream sends an entry. alreadyApplied skips it
      // (we don't have it locally, so it actually writes —
      // pick a path that won't conflict).
      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 2,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      // pushRev must NOT have jumped past the unpushed
      // local write. The local write is at revBeforeApply;
      // we want pushRev still < revBeforeApply so the next
      // pushOnce drains it.
      const pushRevAfter = readWatermark(db, "pushRev");
      expect(pushRevAfter).toBeLessThan(revBeforeApply);
      // The local write should still appear in coalesce.
      const drained = [];
      for await (const e of coalesceChanges(db, pushRevAfter)) drained.push(e);
      const paths = drained.map((e) => (e.kind === "delete" ? e.path : e.path));
      expect(paths).toContain("/local.txt");
    });
  });

  it("leaves pushRev alone even when the caller had no unpushed locals", async () => {
    await withDB(async (db) => {
      const { currentRev, readWatermark, writeWatermark } = await import("./watermarks.js");
      // pushRev already caught up to currentRev: caller has no
      // pending local writes. The old apply path advanced pushRev
      // here as an optimization; we no longer do that because it
      // desynced our pushRev from the remote's fetchRev (echoed
      // back as appliedPushRev on the wire). The next pushOnce
      // re-ships the apply's rev bump and the receiver's
      // alreadyApplied() check drops it.
      const before = currentRev(db);
      writeWatermark(db, "pushRev", before);
      await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/from-upstream.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
        { source: "upstream" },
      );
      const after = currentRev(db);
      expect(after).toBeGreaterThan(before);
      expect(readWatermark(db, "pushRev")).toBe(before);
    });
  });
});

describe("applyChanges with read-only mount roots", () => {
  function stageReadOnly(db: import("../storage.js").Database, root: string): void {
    db.run(
      "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, 'read-only')",
      root,
      "test",
    );
    invalidateReadOnlyMountCache(db);
  }

  it("skips a write entry under a read-only mount and reports it", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      const result = await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 100,
            path: "/workspace/r2/hello.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(0);
      expect(result.skipped).toEqual([
        {
          path: "/workspace/r2/hello.txt",
          mountRoot: "/workspace/r2",
          op: "write",
          reason: "read-only",
        },
      ]);
      // The skipped path is not on disk.
      expect(resolveInode(db, "/workspace/r2/hello.txt")).toBeNull();
    });
  });

  it("skips a delete entry under a read-only mount and reports op:delete", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      const result = await applyChanges(
        db,
        [{ kind: "delete", rev: 101, path: "/workspace/r2/gone.txt" }],
        new Map(),
      );

      expect(result.applied).toBe(0);
      expect(result.skipped).toEqual([
        {
          path: "/workspace/r2/gone.txt",
          mountRoot: "/workspace/r2",
          op: "delete",
          reason: "read-only",
        },
      ]);
    });
  });

  it("skips an entry whose path is exactly the mount root", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      const result = await applyChanges(
        db,
        [
          {
            kind: "dir",
            rev: 102,
            path: "/workspace/r2",
            mode: 0o755,
            mtime: 1,
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(0);
      expect(result.skipped[0]?.mountRoot).toBe("/workspace/r2");
    });
  });

  it("applies entries that lie outside any mount and reports an empty skipped list", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      mkdir(db, "/scratch", { recursive: true }, () => 0);

      const result = await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 103,
            path: "/scratch/ok.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(1);
      expect(result.skipped).toEqual([]);
      expect(resolveInode(db, "/scratch/ok.txt")).not.toBeNull();
    });
  });

  it("does not skip entries under a read-write mount", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/rw", { recursive: true }, () => 0);
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, 'read-write')",
        "/workspace/rw",
        "test",
      );
      invalidateReadOnlyMountCache(db);

      const result = await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 104,
            path: "/workspace/rw/ok.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(1);
      expect(result.skipped).toEqual([]);
    });
  });

  it("folds skip + apply across a mixed batch", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      mkdir(db, "/scratch", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      const result = await applyChanges(
        db,
        [
          {
            kind: "file",
            rev: 200,
            path: "/scratch/a.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
          {
            kind: "file",
            rev: 201,
            path: "/workspace/r2/blocked.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
          {
            kind: "file",
            rev: 202,
            path: "/scratch/b.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(2);
      expect(result.skipped).toEqual([
        {
          path: "/workspace/r2/blocked.txt",
          mountRoot: "/workspace/r2",
          op: "write",
          reason: "read-only",
        },
      ]);
    });
  });

  it("applyChangesSync emits the same SkippedEntry shape", async () => {
    await withDB(async (db) => {
      mkdir(db, "/workspace/r2", { recursive: true }, () => 0);
      stageReadOnly(db, "/workspace/r2");

      const result = applyChangesSync(
        db,
        [
          {
            kind: "file",
            rev: 300,
            path: "/workspace/r2/blocked.txt",
            mode: 0o644,
            mtime: 1,
            size: 0,
            chunks: [],
          },
        ],
        new Map(),
      );

      expect(result.applied).toBe(0);
      expect(result.skipped).toEqual([
        {
          path: "/workspace/r2/blocked.txt",
          mountRoot: "/workspace/r2",
          op: "write",
          reason: "read-only",
        },
      ]);
    });
  });
});

describe("applyChanges mtime propagation (auto_cache contract)", () => {
  // The FUSE driver mounts with COMPUTERD_FUSE_AUTO_CACHE=1 in the
  // production-safe profile. auto_cache tells the kernel to keep
  // file data in the page cache until the file is reopened with a
  // different mtime or size; the kernel then drops the cached
  // pages and re-reads through FUSE. The whole story rests on
  // mtime moving forward whenever the bytes change, including the
  // tricky cases where size stays the same.
  //
  // These tests pin that contract on the sync apply path. If a
  // future apply refactor stops propagating mtime, a container
  // with auto_cache enabled would keep serving the old bytes
  // after a remote push and the cache-coherency story would
  // silently break.

  it("bumps destination mtime when a same-size file changes content", async () => {
    await withTwoDBs(
      async (a) => {
        // Source: write the first version, push, then overwrite
        // with bytes of the same length but a different value
        // and a strictly later mtime.
        await writeFile(a, "/note.txt", "alpha", {}, () => 1000);
        const first = await drain(coalesceChanges(a, 0));
        const firstObjects = await collectObjects(a, first);

        await writeFile(a, "/note.txt", "OMEGA", {}, () => 2000);
        const second = await drain(coalesceChanges(a, Math.max(...first.map((e) => e.rev))));
        const secondObjects = await collectObjects(a, second);
        return { first, firstObjects, second, secondObjects };
      },
      async (b, { first, firstObjects, second, secondObjects }) => {
        await applyChanges(b, first, firstObjects);
        const beforeInode = resolveInode(b, "/note.txt");
        expect(beforeInode).not.toBeNull();
        expect(beforeInode?.mtime).toBe(1000);
        expect(await readFile(b, "/note.txt", "utf8")).toBe("alpha");

        await applyChanges(b, second, secondObjects);
        const afterInode = resolveInode(b, "/note.txt");
        expect(afterInode).not.toBeNull();
        // Bytes changed: the kernel must see a strictly newer
        // mtime so auto_cache drops the page cache on reopen.
        expect(afterInode?.mtime).toBeGreaterThan(beforeInode?.mtime ?? 0);
        expect(afterInode?.mtime).toBe(2000);
        expect(await readFile(b, "/note.txt", "utf8")).toBe("OMEGA");
      },
    );
  });

  it("skips an apply when bytes are identical even if the source mtime is newer", async () => {
    // The mirror of the test above. If a sender pushes the same
    // content with a fresher mtime, the apply path takes the
    // alreadyApplied fast path and does not touch the local row.
    // The local mtime stays put. This is by design: auto_cache
    // only needs to invalidate when bytes change. A pure mtime
    // bump would still be safe (the kernel would invalidate and
    // re-read identical bytes), but it would burn a local rev
    // for nothing.
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/same.txt", "static", {}, () => 1000);
        const first = await drain(coalesceChanges(a, 0));
        const firstObjects = await collectObjects(a, first);
        // Re-stamp the same bytes with a newer mtime on the
        // source. This isn't something writeFile normally
        // produces (it bumps rev and emits the same chunks), but
        // it's the worst case a future sender might present.
        const reissued = first.map((entry): ChangeEntry => {
          if (entry.kind !== "file" || entry.path !== "/same.txt") return entry;
          return { ...entry, mtime: 9999, rev: entry.rev + 1000 };
        });
        return { first, firstObjects, reissued };
      },
      async (b, { first, firstObjects, reissued }) => {
        // First apply is from upstream too, so the local rev
        // counter doesn't claim the bytes as a local write.
        await applyChanges(b, first, firstObjects, { source: "upstream" });
        const beforeInode = resolveInode(b, "/same.txt");
        expect(beforeInode?.mtime).toBe(1000);

        // Reapply with a fresh mtime but identical chunks. The
        // upstream-source guard runs alreadyApplied(), which
        // matches on manifest hash and drops the entry.
        await applyChanges(b, reissued, firstObjects, { source: "upstream" });
        const afterInode = resolveInode(b, "/same.txt");
        // alreadyApplied caught the no-op; the mtime stays at
        // 1000 because the row never moved. auto_cache's safety
        // story is unaffected — the bytes are still the same,
        // so a stale page cache would still return correct bytes.
        expect(afterInode?.mtime).toBe(1000);
      },
    );
  });

  it("bumps destination mtime when a file shrinks", async () => {
    // Size change alone is enough to invalidate auto_cache, but
    // the kernel still consults mtime first. Make sure the
    // shrinking case carries the new mtime through so a fast
    // mtime-cache check at the kernel layer can short-circuit.
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/shrink.txt", "original-content", {}, () => 1000);
        const first = await drain(coalesceChanges(a, 0));
        const firstObjects = await collectObjects(a, first);

        await writeFile(a, "/shrink.txt", "x", {}, () => 2000);
        const second = await drain(coalesceChanges(a, Math.max(...first.map((e) => e.rev))));
        const secondObjects = await collectObjects(a, second);
        return { first, firstObjects, second, secondObjects };
      },
      async (b, { first, firstObjects, second, secondObjects }) => {
        await applyChanges(b, first, firstObjects);
        await applyChanges(b, second, secondObjects);
        const inode = resolveInode(b, "/shrink.txt");
        expect(inode?.mtime).toBe(2000);
        expect(await readFile(b, "/shrink.txt", "utf8")).toBe("x");
      },
    );
  });

  it("bumps mtime on the sync-style synchronous apply path too", async () => {
    // applyChangesSync is the alternate entry point used by
    // SyncRPC.fetch's commit phase. It walks the same
    // alreadyApplied / writeFileSync path as applyChanges, but
    // the two paths are easy to drift apart in a refactor. Lock
    // the same mtime-propagation contract on both.
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/sync.txt", "first", {}, () => 1000);
        const first = await drain(coalesceChanges(a, 0));
        const firstObjects = await collectObjects(a, first);

        await writeFile(a, "/sync.txt", "SECOND", {}, () => 2000);
        const second = await drain(coalesceChanges(a, Math.max(...first.map((e) => e.rev))));
        const secondObjects = await collectObjects(a, second);
        return { first, firstObjects, second, secondObjects };
      },
      async (b, { first, firstObjects, second, secondObjects }) => {
        applyChangesSync(b, first, firstObjects);
        expect(resolveInode(b, "/sync.txt")?.mtime).toBe(1000);
        applyChangesSync(b, second, secondObjects);
        expect(resolveInode(b, "/sync.txt")?.mtime).toBe(2000);
        expect(await readFile(b, "/sync.txt", "utf8")).toBe("SECOND");
      },
    );
  });
});
