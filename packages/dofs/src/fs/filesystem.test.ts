// Smoke tests for the WorkspaceFilesystem class wrapper.
//
// The class is a thin forward to the free fs/* functions, so per-op
// behaviour is already covered by neighbouring tests
// (stat.test.ts, readdir.test.ts, ...). What's tested here is the
// wrapper itself: methods land on the right free function, the
// (db, now) pair gets threaded through, and the documented shape
// at the class boundary matches the free functions.

import { describe, expect, it } from "vitest";

import { WorkspaceFilesystem } from "./filesystem.js";
import { withDB } from "./with-db.js";

async function withFs<T>(
  fn: (fs: WorkspaceFilesystem) => T | Promise<T>,
  now: () => number = () => 1234,
): Promise<T> {
  return withDB((db) => fn(new WorkspaceFilesystem(db, { now })), { now });
}

describe("WorkspaceFilesystem", () => {
  it("writeFile and readFile round-trip utf8", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/hello.txt", "hello world");
      expect(await fs.readFile("/hello.txt", "utf8")).toBe("hello world");
    });
  });

  it("readFile returns a stream by default", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/bin", new Uint8Array([1, 2, 3, 4]));
      const stream = await fs.readFile("/bin");
      expect(stream).toBeInstanceOf(ReadableStream);
      const buf = new Uint8Array(await new Response(stream).arrayBuffer());
      expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
    });
  });

  it("stat returns the documented shape for a file", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/a.txt", "ab");
      const s = await fs.stat("/a.txt");
      expect(s).toMatchObject({
        name: "a.txt",
        size: 2,
        isFile: true,
        isDirectory: false,
      });
    });
  });

  it("stat throws ENOENT for a missing path", async () => {
    await withFs(async (fs) => {
      await expect(fs.stat("/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("mkdir creates a directory that stat recognises", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/d");
      const s = await fs.stat("/d");
      expect(s.isDirectory).toBe(true);
    });
  });

  it("readdir lists immediate children only", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/d");
      await fs.writeFile("/d/a.txt", "a");
      await fs.writeFile("/d/b.txt", "b");
      await fs.mkdir("/d/sub");
      await fs.writeFile("/d/sub/deep.txt", "deep");
      const names = (await fs.readdir("/d")).map((e) => e.name).sort();
      expect(names).toEqual(["a.txt", "b.txt", "sub"]);
    });
  });

  it("find walks subtrees and ls flattens paths", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/p");
      await fs.writeFile("/p/a.txt", "a");
      await fs.mkdir("/p/q");
      await fs.writeFile("/p/q/b.txt", "b");

      const found = (await fs.find("/p")).map((e) => e.path).sort();
      expect(found).toContain("/p/a.txt");
      expect(found).toContain("/p/q/b.txt");

      const flat = (await fs.ls("/p")).sort();
      expect(flat).toContain("/p/a.txt");
      expect(flat).toContain("/p/q/b.txt");
    });
  });

  it("grep finds matching lines", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/notes.txt", "alpha\nbeta\ngamma\n");
      const hits = await fs.grep("beta", "/notes.txt");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe("beta");
    });
  });

  it("rm removes a file; rm with recursive removes a directory tree", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/x.txt", "x");
      await fs.rm("/x.txt");
      await expect(fs.stat("/x.txt")).rejects.toMatchObject({ code: "ENOENT" });

      await fs.mkdir("/tree");
      await fs.writeFile("/tree/inner.txt", "i");
      await fs.rm("/tree", { recursive: true });
      await expect(fs.stat("/tree")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("chmod updates the stored mode", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/a", "hi");
      await fs.chmod("/a", 0o600);
      expect((await fs.stat("/a")).mode).toBe(0o600);
    });
  });

  it("symlink + readlink round-trip", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/target", "hi");
      await fs.symlink("/target", "/link");
      expect(await fs.readlink("/link")).toBe("/target");
    });
  });

  it("stat follows symlinks; lstat reports the link itself", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/target", "hello");
      await fs.symlink("/target", "/link");
      const s = await fs.stat("/link");
      expect(s.isFile).toBe(true);
      expect(s.isSymbolicLink).toBe(false);
      const l = await fs.lstat("/link");
      expect(l.isSymbolicLink).toBe(true);
      expect(l.isFile).toBe(false);
      expect(l.size).toBe("/target".length);
    });
  });

  it("threads the injected clock through writeFile", async () => {
    let t = 5000;
    await withFs(
      async (fs) => {
        await fs.writeFile("/clock.txt", "c");
        const s = await fs.stat("/clock.txt");
        expect(s.mtime).toBe(5000);

        t = 9000;
        await fs.writeFile("/clock.txt", "c2");
        const s2 = await fs.stat("/clock.txt");
        expect(s2.mtime).toBe(9000);
      },
      () => t,
    );
  });
});
