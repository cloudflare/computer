import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";

import { parseStoreMode, resolveStore } from "./store.js";

// A temp directory that removes itself when the calling test ends.
function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "computerd-store-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("parseStoreMode", () => {
  test("treats an unset value as the in-memory store", () => {
    expect(parseStoreMode(undefined)).toEqual({ kind: "memory" });
  });

  test("treats an empty value as the in-memory store", () => {
    expect(parseStoreMode("")).toEqual({ kind: "memory" });
  });

  test("treats the literal 'memory' as the in-memory store", () => {
    expect(parseStoreMode("memory")).toEqual({ kind: "memory" });
  });

  test("treats an absolute path as a file store", () => {
    expect(parseStoreMode("/var/lib/computerd/state.db")).toEqual({
      kind: "file",
      path: "/var/lib/computerd/state.db",
    });
  });

  test("rejects a relative path and names the variable", () => {
    expect(() => parseStoreMode("state.db")).toThrow(/COMPUTERD_DB/);
  });

  test("rejects a relative path that walks upward", () => {
    expect(() => parseStoreMode("../state.db")).toThrow(/COMPUTERD_DB/);
  });

  test("normalizes a path with redundant segments", () => {
    expect(parseStoreMode("/var/lib/../lib/computerd/state.db")).toEqual({
      kind: "file",
      path: "/var/lib/computerd/state.db",
    });
  });
});

describe("resolveStore", () => {
  test("passes the in-memory store through", () => {
    expect(resolveStore({ kind: "memory" }, "/workspace")).toEqual({ kind: "memory" });
  });

  test("reports a file store as fresh when the file does not exist", () => {
    const path = join(createTempDir(), "state.db");
    expect(resolveStore({ kind: "file", path }, "/workspace")).toEqual({
      kind: "file",
      path,
      fresh: true,
    });
  });

  test("reports a file store as not fresh when the file already exists", () => {
    const path = join(createTempDir(), "state.db");
    writeFileSync(path, "");
    expect(resolveStore({ kind: "file", path }, "/workspace")).toEqual({
      kind: "file",
      path,
      fresh: false,
    });
  });

  test("rejects a store inside the mount point", () => {
    expect(() => resolveStore({ kind: "file", path: "/workspace/state.db" }, "/workspace")).toThrow(
      /mount point/i,
    );
  });

  test("rejects a store deeper inside the mount point", () => {
    expect(() =>
      resolveStore({ kind: "file", path: "/workspace/nested/state.db" }, "/workspace"),
    ).toThrow(/mount point/i);
  });

  test("rejects a store at the mount point itself", () => {
    expect(() => resolveStore({ kind: "file", path: "/workspace" }, "/workspace")).toThrow(
      /mount point/i,
    );
  });

  test("allows a sibling directory whose name merely starts with the mount point", () => {
    const resolved = resolveStore(
      { kind: "file", path: "/workspace-other/state.db" },
      "/workspace",
    );
    expect(resolved).toEqual({ kind: "file", path: "/workspace-other/state.db", fresh: true });
  });

  test("allows a store outside a mount point given with a trailing slash", () => {
    const resolved = resolveStore({ kind: "file", path: "/var/lib/state.db" }, "/workspace/");
    expect(resolved).toEqual({ kind: "file", path: "/var/lib/state.db", fresh: true });
  });

  test("rejects a store inside a mount point given with a trailing slash", () => {
    expect(() =>
      resolveStore({ kind: "file", path: "/workspace/state.db" }, "/workspace/"),
    ).toThrow(/mount point/i);
  });
});
