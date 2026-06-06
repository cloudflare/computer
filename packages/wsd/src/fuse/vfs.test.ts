import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { createNodeVirtualFileSystem } from "./index.js";

test("createNodeVirtualFileSystem returns a @platformatic/vfs filesystem", async () => {
  const { vfs } = await createNodeVirtualFileSystem();

  vfs.mkdirSync("/project", { recursive: true });
  vfs.writeFileSync("/project/hello.txt", Buffer.from("hello"));

  expect(vfs.readdirSync("/")).toEqual(["project"]);
  expect(vfs.readdirSync("/project")).toEqual(["hello.txt"]);
  expect(vfs.readFileSync("/project/hello.txt").toString()).toBe("hello");

  vfs.renameSync("/project/hello.txt", "/project/greeting.txt");
  expect(vfs.existsSync("/project/hello.txt")).toBe(false);
  expect(vfs.readFileSync("/project/greeting.txt").toString()).toBe("hello");

  vfs.unlinkSync("/project/greeting.txt");
  expect(vfs.readdirSync("/project")).toEqual([]);
});

test("createNodeVirtualFileSystem pulls initial state from an upstream SyncRPC", async () => {
  const bytes = Buffer.from("hi");
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest());

  let fetchChangesCalls = 0;
  const upstream = {
    async fetchChanges() {
      fetchChangesCalls++;
      return {
        currentCursor: { rev: 1, path: null },
        appliedPushCursor: { rev: 0, path: null },
        stream: new ReadableStream({
          start(c) {
            c.enqueue({
              kind: "file",
              rev: 1,
              path: "/hi.txt",
              mode: 0o644,
              mtime: 100,
              size: 2,
              chunks: [{ hash, size: 2 }],
            });
            c.close();
          },
        }),
      };
    },
    async hasObjects(hashes) {
      // The fake upstream is the source of truth for this file's
      // chunk. Reply that we have every hash the client probes.
      return hashes;
    },
    async fetchObjects(hashes) {
      return new ReadableStream({
        start(c) {
          for (const h of hashes) c.enqueue({ hash: h, bytes });
          c.close();
        },
      });
    },
    async push() {
      return { rev: 0, appliedPushCursor: { rev: 0, path: null } };
    },
    async pushObjects() {},
  };

  const { vfs } = await createNodeVirtualFileSystem({ upstream });
  expect(fetchChangesCalls).toBe(1);
  expect(vfs.readFileSync("/hi.txt").toString()).toBe("hi");
});
