import { describe, expect, it } from "vitest";

import { chmod } from "../fs/chmod";
import { link } from "../fs/link";
import { mkdir } from "../fs/mkdir";
import { rename } from "../fs/rename";
import { resolveInode } from "../fs/resolve";
import { rm } from "../fs/rm";
import { symlink } from "../fs/symlink";
import { withDB } from "../fs/with-db";
import { writeFile } from "../fs/writeFile";
import { materialiseChange } from "./changes";
import { fingerprintVersion, versionFingerprint } from "./fingerprint";
import { computeManifestHash } from "./manifests";

// A tombstone carries the fingerprint of the version it removed, so a
// receiver can tell "the sender deleted exactly what I have" from "the
// sender deleted something older than what I have". The fingerprint
// covers what a delete would destroy: type, permission bits, and the
// content (file manifest or symlink target). It ignores revs and
// mtimes, which differ between peers holding the same version.

function fingerprintAt(db: Parameters<typeof versionFingerprint>[0], path: string) {
  const live = resolveInode(db, path, { followSymlinks: false });
  if (live === null) throw new Error(`no such path ${path}`);
  return versionFingerprint(db, live.inode);
}

describe("version fingerprints", () => {
  it("match for the same content and mode on independent databases", async () => {
    let first: string | undefined;
    await withDB(async (db) => {
      await writeFile(db, "/x", "same bytes", { mode: 0o644 }, () => 1);
      first = fingerprintAt(db, "/x");
    });
    await withDB(async (db) => {
      await writeFile(db, "/elsewhere", "warm up the rev counter", {}, () => 1);
      await writeFile(db, "/x", "same bytes", { mode: 0o644 }, () => 999);
      expect(fingerprintAt(db, "/x")).toBe(first);
    });
  });

  it("differ when the content or the mode differs", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a", "one", { mode: 0o644 }, () => 1);
      await writeFile(db, "/b", "two", { mode: 0o644 }, () => 1);
      await writeFile(db, "/c", "one", { mode: 0o755 }, () => 1);
      expect(fingerprintAt(db, "/a")).not.toBe(fingerprintAt(db, "/b"));
      expect(fingerprintAt(db, "/a")).not.toBe(fingerprintAt(db, "/c"));
    });
  });

  it("match a version described by its wire fields", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/empty", "", { mode: 0o644 }, () => 1);
      expect(fingerprintAt(db, "/empty")).toBe(
        fingerprintVersion({ type: "file", mode: 0o644, manifest: computeManifestHash([]) }),
      );
      symlink(db, "/target", "/link", () => 1);
      const live = resolveInode(db, "/link", { followSymlinks: false });
      expect(fingerprintAt(db, "/link")).toBe(
        fingerprintVersion({ type: "symlink", mode: live?.mode ?? 0, target: "/target" }),
      );
    });
  });

  it("describe a directory by its mode alone", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", { mode: 0o755 }, () => 1);
      expect(fingerprintAt(db, "/d")).toBe(fingerprintVersion({ type: "dir", mode: 0o755 }));
    });
  });
});

describe("tombstones carry the removed version's fingerprint", () => {
  it("records it when a file is removed", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/gone.txt", "bye", {}, () => 1);
      const before = fingerprintAt(db, "/gone.txt");
      rm(db, "/gone.txt", {});
      expect(materialiseChange(db, "/gone.txt")).toEqual({
        kind: "delete",
        rev: expect.any(Number),
        path: "/gone.txt",
        prior: before,
      });
    });
  });

  it("records one per path in a recursive removal", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree/sub", { recursive: true }, () => 1);
      await writeFile(db, "/tree/a", "a", {}, () => 1);
      await writeFile(db, "/tree/sub/b", "b", {}, () => 1);
      const expected = {
        "/tree": fingerprintAt(db, "/tree"),
        "/tree/sub": fingerprintAt(db, "/tree/sub"),
        "/tree/a": fingerprintAt(db, "/tree/a"),
        "/tree/sub/b": fingerprintAt(db, "/tree/sub/b"),
      };
      rm(db, "/tree", { recursive: true });
      for (const [path, prior] of Object.entries(expected)) {
        expect(materialiseChange(db, path)).toMatchObject({ kind: "delete", path, prior });
      }
    });
  });

  it("records the moved file's fingerprint at its old path", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/old", "moving", {}, () => 1);
      const before = fingerprintAt(db, "/old");
      rename(db, "/old", "/new");
      expect(materialiseChange(db, "/old")).toMatchObject({ kind: "delete", prior: before });
    });
  });

  it("records the shared content when one hardlinked name is removed", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/x", "shared", {}, () => 1);
      link(db, "/x", "/y");
      const before = fingerprintAt(db, "/y");
      rm(db, "/y", {});
      expect(materialiseChange(db, "/y")).toMatchObject({ kind: "delete", prior: before });
      expect(fingerprintAt(db, "/x")).toBe(before);
    });
  });

  it("records the mode a directory had when it was removed", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", { mode: 0o700 }, () => 1);
      chmod(db, "/d", 0o750, () => 2);
      rm(db, "/d", {});
      expect(materialiseChange(db, "/d")).toMatchObject({
        prior: fingerprintVersion({ type: "dir", mode: 0o750 }),
      });
    });
  });
});
