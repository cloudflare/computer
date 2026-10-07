import { describe, expect, it } from "vitest";
import { deleteFromStore } from "./delete.js";
import type { MutableFileStore } from "./types.js";

function store(remove: MutableFileStore["remove"]): MutableFileStore {
  return {
    async stat() {
      return null;
    },
    async *readChunks() {},
    async readAll() {
      return null;
    },
    async write() {},
    remove,
  };
}

describe("deleteFromStore", () => {
  it("uses forced idempotent removal and forwards recursive", async () => {
    const calls: Array<{ path: string; recursive?: boolean; force?: boolean }> = [];
    const target = store(async (path, options) => {
      calls.push({ path, ...options });
    });

    await expect(
      deleteFromStore({ store: target }, { path: "/workspace/build", recursive: true }),
    ).resolves.toEqual({ deleted: "/workspace/build" });
    expect(calls).toEqual([{ path: "/workspace/build", recursive: true, force: true }]);
  });

  it("returns structured filesystem errors", async () => {
    const target = store(async () => {
      throw new Error("directory not empty");
    });

    await expect(deleteFromStore({ store: target }, { path: "/workspace/build" })).resolves.toEqual(
      { error: "directory not empty" },
    );
  });
});
