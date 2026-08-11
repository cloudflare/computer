import { describe, expect, it } from "vitest";
import { withFileLock } from "./locks.js";
import type { FileStore } from "./types.js";

function store(lockIdentity?: object): FileStore {
  return {
    lockIdentity,
    async stat() {
      return null;
    },
    async *readChunks() {},
    async readAll() {
      return null;
    },
    async write() {},
  };
}

describe("withFileLock", () => {
  it("serializes normalized aliases of the same path", async () => {
    const target = store();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withFileLock(target, "/workspace/a/../file", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    await Promise.resolve();
    const second = withFileLock(target, "/workspace/file", async () => {
      events.push("second");
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    release?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("shares locks through lockIdentity but isolates other stores", async () => {
    const identity = {};
    const firstStore = store(identity);
    const secondStore = store(identity);
    const independent = store();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = withFileLock(firstStore, "/same", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    await Promise.resolve();
    const shared = withFileLock(secondStore, "/same", async () => {
      events.push("shared");
    });
    const separate = withFileLock(independent, "/same", async () => {
      events.push("separate");
    });
    await separate;

    expect(events).toEqual(["first:start", "separate"]);
    release?.();
    await Promise.all([first, shared]);
    expect(events).toEqual(["first:start", "separate", "first:end", "shared"]);
  });

  it("blocks ancestor and descendant mutations for subtree locks only", async () => {
    const target = store();
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const subtree = withFileLock(
      target,
      "/workspace/tree",
      async () => {
        events.push("tree:start");
        await gate;
        events.push("tree:end");
      },
      { subtree: true },
    );
    await Promise.resolve();
    const descendant = withFileLock(target, "/workspace/tree/file", async () => {
      events.push("descendant");
    });
    const unrelated = withFileLock(target, "/workspace/other", async () => {
      events.push("unrelated");
    });
    await unrelated;

    expect(events).toEqual(["tree:start", "unrelated"]);
    release?.();
    await Promise.all([subtree, descendant]);
    expect(events).toEqual(["tree:start", "unrelated", "tree:end", "descendant"]);
  });

  it("releases a lock when the operation rejects", async () => {
    const target = store();
    await expect(
      withFileLock(target, "/workspace/file", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");

    await expect(withFileLock(target, "/workspace/file", async () => "next")).resolves.toBe("next");
  });
});
