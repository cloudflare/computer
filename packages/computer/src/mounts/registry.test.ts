import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { Workspace } from "../workspace.js";
import type { Mount, MountContext, MountFactory } from "./types.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

// A minimal backend list. mounts/* tests don't exercise the wire;
// constructing a Workspace doesn't try to connect, so we never need
// to await ready() in these tests.
const backends = [
  {
    id: "test",
    connect: () => Promise.reject(new Error("not used in these tests")),
  },
];

function eager(kind = "fake"): Mount {
  return {
    kind,
    mode: "read-only",
    strategy: "eager",
    async materialize() {},
  };
}

describe("mount registry", () => {
  it("accepts a valid mounts map without throwing", () => {
    expect(
      () =>
        new Workspace({
          storage: makeStorage(),
          backends,
          mounts: {
            "/workspace/a": eager(),
            "/workspace/b": eager(),
          },
        }),
    ).not.toThrow();
  });

  it("accepts a bare Mount value (not invoked as a factory)", () => {
    const mount = eager();
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      mounts: { "/workspace/x": mount },
    });
    expect(ws.mounts().get("/workspace/x")).toBe(mount);
  });

  it("calls a MountFactory exactly once with a MountContext", () => {
    const factory = vi.fn<MountFactory>((ctx) => {
      expect(ctx.root).toBe("/workspace/data");
      expect(typeof ctx.sessionId).toBe("string");
      expect(ctx.vfs).toBeDefined();
      return eager("from-factory");
    });
    const ws = new Workspace({
      storage: makeStorage(),
      backends,
      sessionId: "session-42",
      mounts: { "/workspace/data": factory },
    });
    expect(factory).toHaveBeenCalledTimes(1);
    const ctx = factory.mock.calls[0][0] as MountContext;
    expect(ctx.sessionId).toBe("session-42");
    expect(ctx.root).toBe("/workspace/data");
    expect(ws.mounts().get("/workspace/data")?.kind).toBe("from-factory");
  });

  it("rejects nested roots and names both in the error", () => {
    expect(
      () =>
        new Workspace({
          storage: makeStorage(),
          backends,
          mounts: {
            "/workspace/a": eager(),
            "/workspace/a/b": eager(),
          },
        }),
    ).toThrow(/\/workspace\/a.*\/workspace\/a\/b|\/workspace\/a\/b.*\/workspace\/a/);
  });

  it("rejects relative roots", () => {
    expect(
      () =>
        new Workspace({
          storage: makeStorage(),
          backends,
          mounts: { "workspace/a": eager() },
        }),
    ).toThrow(/absolute/);
  });

  it("rejects trailing slashes", () => {
    expect(
      () =>
        new Workspace({
          storage: makeStorage(),
          backends,
          mounts: { "/workspace/a/": eager() },
        }),
    ).toThrow(/trailing/);
  });

  it("omitting mounts leaves the registry empty", () => {
    const ws = new Workspace({ storage: makeStorage(), backends });
    expect(ws.mounts().size).toBe(0);
  });
});
