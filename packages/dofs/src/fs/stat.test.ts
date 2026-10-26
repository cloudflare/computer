import { describe, expect, it } from "vitest";

import { mkdir } from "./mkdir";
import { lstat, stat } from "./stat";
import { symlink } from "./symlink";
import { withDB } from "./with-db";
import { writeFileSync } from "./writeFile";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("stat", () => {
  it("reports a regular file", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", utf8("hello"), { mode: 0o644 }, () => 1234);
      const s = stat(db, "/a.txt");
      expect(s).toMatchObject({
        name: "a.txt",
        mode: 0o644,
        size: 5,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        mtime: 1234,
      });
    });
  });

  it("reports a directory", async () => {
    await withDB((db) => {
      mkdir(db, "/d", { mode: 0o700 }, () => 0);
      const s = stat(db, "/d");
      expect(s).toMatchObject({
        name: "d",
        mode: 0o700,
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    });
  });

  it("follows symlinks", async () => {
    // stat() on a symlink reports the target. The link itself is
    // observable only via lstat().
    await withDB((db) => {
      writeFileSync(db, "/target", utf8("hello"), { mode: 0o600 }, () => 0);
      symlink(db, "/target", "/link", () => 0);
      const s = stat(db, "/link");
      expect(s.isFile).toBe(true);
      expect(s.isSymbolicLink).toBe(false);
      expect(s.mode).toBe(0o600);
      expect(s.size).toBe(5);
    });
  });

  it("throws ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => stat(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });
  });
});

describe("lstat", () => {
  it("reports a symlink without following it", async () => {
    // POSIX lstat: size is the byte length of the stored target,
    // mode is the symlink node's own mode (always 0o777 today).
    await withDB((db) => {
      writeFileSync(db, "/target", utf8("hello world"), {}, () => 0);
      symlink(db, "/target", "/link", () => 0);
      const s = lstat(db, "/link");
      expect(s.isSymbolicLink).toBe(true);
      expect(s.isFile).toBe(false);
      expect(s.isDirectory).toBe(false);
      expect(s.size).toBe("/target".length);
      expect(s.mode).toBe(0o777);
    });
  });

  it("matches stat for non-symlink nodes", async () => {
    await withDB((db) => {
      writeFileSync(db, "/a.txt", utf8("hi"), {}, () => 0);
      const s = stat(db, "/a.txt");
      const l = lstat(db, "/a.txt");
      expect(l).toEqual(s);
    });
  });

  it("throws ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => lstat(db, "/missing")).toThrowError(expect.objectContaining({ code: "ENOENT" }));
    });
  });

  it("returns the dangling symlink itself when the target is missing", async () => {
    await withDB((db) => {
      symlink(db, "/nowhere", "/dangling", () => 0);
      const s = lstat(db, "/dangling");
      expect(s.isSymbolicLink).toBe(true);
      expect(s.size).toBe("/nowhere".length);
    });
  });
});
