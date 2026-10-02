import { describe, expect, it } from "vitest";

import type { FileStore } from "./types.js";
import { writeToStore } from "./write.js";

function store(overrides: Partial<FileStore> = {}): FileStore {
  return {
    async stat() {
      return null;
    },
    async *readChunks() {},
    async readAll() {
      return null;
    },
    async write() {},
    ...overrides,
  };
}

describe("writeToStore", () => {
  it("preserves the mode when overwriting a file", async () => {
    const writes: Array<{ content: string; mode?: number }> = [];
    const target = store({
      async stat() {
        return { size: 3, mtime: 1, mode: 0o100755 };
      },
      async write(_path, content, options) {
        writes.push({ content: new TextDecoder().decode(content), mode: options?.mode });
      },
    });

    await expect(
      writeToStore({ store: target }, { path: "/workspace/script.sh", content: "new" }),
    ).resolves.toEqual({ path: "/workspace/script.sh", bytesWritten: 3 });
    expect(writes).toEqual([{ content: "new", mode: 0o100755 }]);
  });

  it("returns structured filesystem errors", async () => {
    const target = store({
      async write() {
        throw new Error("disk full");
      },
    });

    await expect(
      writeToStore({ store: target }, { path: "/workspace/out.txt", content: "new" }),
    ).resolves.toEqual({ error: "disk full" });
  });

  it("rejects content over the UTF-8 byte cap", async () => {
    const target = store();

    await expect(
      writeToStore({ store: target, maxBytes: 3 }, { path: "/workspace/out.txt", content: "éé" }),
    ).resolves.toEqual({
      error:
        "Content too large: 4 bytes exceeds the 3-byte write cap. Use the edit tool for incremental changes to existing files, or split the write into smaller pieces.",
    });
  });
});
