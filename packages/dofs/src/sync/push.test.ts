import { describe, expect, it } from "vitest";
import { mkdir } from "../fs/mkdir";
import { readFile } from "../fs/readFile";
import { resolveInode } from "../fs/resolve";
import { rm } from "../fs/rm";
import { symlink } from "../fs/symlink";
import { withDB, withTwoDBs } from "../fs/with-db";
import { writeFile } from "../fs/writeFile";
import type { Database } from "../storage";
import type { ChangeEntry } from "./changes";
import { coalesceChanges } from "./coalesce";
import { pushObjects } from "./push";

// Minimal hand-rolled apply loop. We just need to prove that
// coalesceChanges + pushObjects together transfer enough information
// for the receiver to converge.
async function apply(db: Database, entries: ChangeEntry[], objects: Map<string, Uint8Array>) {
  for (const entry of entries) {
    if (entry.kind === "delete") {
      try {
        rm(db, entry.path, { recursive: true, force: true });
      } catch {
        // Path may already be gone if the receiver was empty.
      }
      continue;
    }
    if (entry.kind === "dir") {
      mkdir(db, entry.path, { mode: entry.mode, recursive: true }, () => entry.mtime);
      continue;
    }
    if (entry.kind === "symlink") {
      // Best-effort: writeFile to a path the symlink replaces won't
      // round-trip through symlink. For this test we never overwrite
      // a symlink with a non-symlink, so a fresh create is fine.
      symlink(db, entry.target, entry.path, () => entry.mtime);
      continue;
    }
    // file: assemble bytes from the chunks the sender shipped.
    const parts: Uint8Array[] = [];
    for (const c of entry.chunks) {
      const key = hex(c.hash);
      const bytes = objects.get(key);
      if (bytes === undefined) throw new Error(`missing object for ${key}`);
      parts.push(bytes);
    }
    const total = parts.reduce((acc, p) => acc + p.byteLength, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      buf.set(p, off);
      off += p.byteLength;
    }
    await writeFile(db, entry.path, buf, { mode: entry.mode }, () => entry.mtime);
  }
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("push", () => {
  it("transfers a single file end-to-end", async () => {
    await withTwoDBs(
      async (a) => {
        await writeFile(a, "/hello.txt", "hello world", { mode: 0o644 }, () => 100);
        const entries = await drain(coalesceChanges(a, 0));
        const objects = await pull(a, collectHashes(entries));
        return { entries, objects };
      },
      async (b, { entries, objects }) => {
        await apply(b, entries, objects);
        const node = resolveInode(b, "/hello.txt");
        expect(node?.type).toBe("file");
        const got = await readFile(b, "/hello.txt", "utf8");
        expect(got).toBe("hello world");
      },
    );
  });

  it("converges across mixed mutations", async () => {
    await withTwoDBs(
      async (a) => {
        mkdir(a, "/d", { mode: 0o755 }, () => 1);
        await writeFile(a, "/d/a.txt", "alpha", {}, () => 2);
        await writeFile(a, "/d/b.txt", "beta", {}, () => 3);
        symlink(a, "/d/a.txt", "/link", () => 4);
        await writeFile(a, "/tmp.txt", "scratch", {}, () => 5);
        rm(a, "/tmp.txt", {});
        const entries = await drain(coalesceChanges(a, 0));
        const objects = await pull(a, collectHashes(entries));
        return { entries, objects };
      },
      async (b, { entries, objects }) => {
        await apply(b, entries, objects);
        expect(await readFile(b, "/d/a.txt", "utf8")).toBe("alpha");
        expect(await readFile(b, "/d/b.txt", "utf8")).toBe("beta");
        expect(resolveInode(b, "/tmp.txt")).toBeNull();
        const linked = await readFile(b, "/link", "utf8");
        expect(linked).toBe("alpha");
      },
    );
  });

  it("pushObjects yields each requested hash exactly once", async () => {
    await withDB(async (a) => {
      await writeFile(a, "/a.txt", "same", {}, () => 1);
      await writeFile(a, "/b.txt", "same", {}, () => 2);
      const entries = await drain(coalesceChanges(a, 0));
      const hashes = collectHashes(entries);
      // Both files reuse one chunk hash; collectHashes already
      // dedups, so we should see exactly one object on the wire.
      expect(hashes).toHaveLength(1);
      const objects = await pull(a, hashes);
      expect(objects.size).toBe(1);
    });
  });

  it("pushObjects throws EUNKNOWN_HASH when a hash is not in vfs_blob_bytes", async () => {
    await withDB(async (a) => {
      const unknown = new Uint8Array(32);
      unknown.fill(0xff);
      let caught: unknown;
      try {
        for await (const _ of pushObjects(a, [unknown])) {
          // drain
        }
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code).toBe("EUNKNOWN_HASH");
    });
  });
});

function collectHashes(entries: ChangeEntry[]): Uint8Array[] {
  const seen = new Set<string>();
  const out: Uint8Array[] = [];
  for (const e of entries) {
    if (e.kind !== "file") continue;
    for (const c of e.chunks) {
      const key = hex(c.hash);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(c.hash);
      }
    }
  }
  return out;
}

async function pull(db: Database, hashes: Uint8Array[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for await (const { hash, bytes } of pushObjects(db, hashes)) {
    out.set(hex(hash), bytes);
  }
  return out;
}
