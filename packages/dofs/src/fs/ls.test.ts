import { describe, expect, it } from "vitest";

import { ls } from "./ls.js";
import { mkdir } from "./mkdir.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { writeFile } from "./writeFile.js";

describe("ls", () => {
  it("returns an empty array when nothing matches", async () => {
    await withDB((db) => {
      expect(ls(db, "/")).toEqual([]);
    });
  });

  it("lists every file under root sorted by path", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/x.ts", "", {}, () => 0);
      await writeFile(db, "/a/y.ts", "", {}, () => 0);
      await writeFile(db, "/z.ts", "", {}, () => 0);
      expect(ls(db, "/")).toEqual(["/a/b/x.ts", "/a/y.ts", "/z.ts"]);
    });
  });

  it("returns only files, not directory entries", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/b/x", "", {}, () => 0);
      expect(ls(db, "/")).toEqual(["/a/b/x"]);
    });
  });

  it("matches an exact subtree by prefix", async () => {
    await withDB(async (db) => {
      mkdir(db, "/wsp", {}, () => 0);
      mkdir(db, "/workspace", {}, () => 0);
      await writeFile(db, "/wsp/a", "", {}, () => 0);
      await writeFile(db, "/workspace/b", "", {}, () => 0);
      await writeFile(db, "/workspace/c", "", {}, () => 0);
      expect(ls(db, "/workspace")).toEqual(["/workspace/b", "/workspace/c"]);
    });
  });

  it("returns just the file path when the prefix is a file", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a", {}, () => 0);
      await writeFile(db, "/a/x.ts", "hi", {}, () => 0);
      expect(ls(db, "/a/x.ts")).toEqual(["/a/x.ts"]);
    });
  });

  it("returns an empty array for a missing prefix", async () => {
    await withDB((db) => {
      expect(ls(db, "/no/such/prefix")).toEqual([]);
    });
  });

  it("lists a nested subdirectory without scanning sibling subtrees", async () => {
    await withDB(async (db) => {
      mkdir(db, "/a/deep", { recursive: true }, () => 0);
      mkdir(db, "/b", { recursive: true }, () => 0);
      await writeFile(db, "/a/deep/x.ts", "", {}, () => 0);
      await writeFile(db, "/a/deep/y.ts", "", {}, () => 0);
      await writeFile(db, "/a/top.ts", "", {}, () => 0);
      await writeFile(db, "/b/other.ts", "", {}, () => 0);
      expect(ls(db, "/a/deep")).toEqual(["/a/deep/x.ts", "/a/deep/y.ts"]);
    });
  });

  it("does not follow a symlink prefix", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      await writeFile(db, "/real/f.ts", "", {}, () => 0);
      symlink(db, "/real", "/link", () => 0);
      // A symlink is a leaf with no dirents, so listing at or through
      // it yields nothing; the real directory still lists normally.
      expect(ls(db, "/link")).toEqual([]);
      expect(ls(db, "/link/f.ts")).toEqual([]);
      expect(ls(db, "/real")).toEqual(["/real/f.ts"]);
    });
  });
});
