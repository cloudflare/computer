import { describe, expect, it } from "vitest";

import { withDB } from "../fs/with-db.js";
import { createFileSync, writeFile, writeRangeSync } from "../fs/writeFile.js";
import { coalesceChanges } from "./coalesce.js";
import { fetchChanges, fetchObjects, hasObjects } from "./fetch.js";

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("fetch wire", () => {
  it("fetchChanges yields the same entries as coalesceChanges", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "alpha", {}, () => 1);
      await writeFile(db, "/b.txt", "beta", {}, () => 2);
      const viaCoalesce = await drain(coalesceChanges(db, 0));
      const viaFetch = await drain(fetchChanges(db, 0));
      expect(viaFetch).toEqual(viaCoalesce);
    });
  });

  it("fetchChanges and fetchObjects include small direct writes", async () => {
    await withDB(async (db) => {
      createFileSync(db, "/inline.txt", {}, () => 1);
      writeRangeSync(db, "/inline.txt", new TextEncoder().encode("inline direct"), 0, {}, () => 2);

      const entries = await drain(fetchChanges(db, 0));
      const file = entries.find((entry) => entry.kind === "file" && entry.path === "/inline.txt");
      expect(file).toMatchObject({ kind: "file", size: "inline direct".length });
      expect(file?.kind === "file" ? file.chunks : []).toHaveLength(1);
      const hash = file?.kind === "file" ? file.chunks[0].hash : new Uint8Array();
      const objects = await drain(fetchObjects(db, [hash]));
      expect(objects).toHaveLength(1);
      expect(new TextDecoder().decode(objects[0].bytes)).toBe("inline direct");
    });
  });

  it("fetchObjects yields each hash exactly once", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "shared", {}, () => 1);
      await writeFile(db, "/b.txt", "shared", {}, () => 2);
      // Pick the single chunk hash from the file entry.
      const entries = await drain(fetchChanges(db, 0));
      const hashes: Uint8Array[] = [];
      for (const e of entries) {
        if (e.kind === "file") hashes.push(...e.chunks.map((c) => c.hash));
      }
      // Two files, same content, so two references to one hash.
      expect(hashes).toHaveLength(2);
      const seen = new Set<string>();
      for await (const { hash, bytes } of fetchObjects(db, [hashes[0]])) {
        seen.add(Array.from(hash).join(","));
        expect(new TextDecoder().decode(bytes)).toBe("shared");
      }
      expect(seen.size).toBe(1);
    });
  });
});

describe("hasObjects", () => {
  it("returns the subset of inputs the receiver already holds", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "alpha", {}, () => 1);
      const entries = await drain(fetchChanges(db, 0));
      const known = (entries.find((e) => e.kind === "file") as { chunks: { hash: Uint8Array }[] })
        .chunks[0].hash;
      const unknown = new Uint8Array(32);
      unknown.fill(0xff);
      const got = hasObjects(db, [known, unknown]);
      expect(got).toHaveLength(1);
      expect(got[0]).toEqual(known);
    });
  });

  it("returns an empty array when nothing matches", async () => {
    await withDB(async (db) => {
      const zero = new Uint8Array(32);
      expect(hasObjects(db, [zero])).toEqual([]);
    });
  });

  it("returns an empty array when no hashes are passed", async () => {
    await withDB(async (db) => {
      expect(hasObjects(db, [])).toEqual([]);
    });
  });
});
