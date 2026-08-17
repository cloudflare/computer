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
