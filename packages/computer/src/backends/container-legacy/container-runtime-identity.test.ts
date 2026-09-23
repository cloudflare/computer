import { describe, expect, it, vi } from "vitest";

import { CurrentContainerRuntimeIdentity } from "./container-runtime-identity.js";

function storage(initial = new Map<string, unknown>()) {
  return {
    get: vi.fn(async (key: string) => initial.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      initial.set(key, value);
    }),
    delete: vi.fn(async (key: string) => initial.delete(key)),
  };
}

describe("CurrentContainerRuntimeIdentity", () => {
  it("persists a UUID for a newly started container runtime", async () => {
    const backing = new Map<string, unknown>();
    const current = new CurrentContainerRuntimeIdentity(storage(backing));

    const runtime = await current.markStarted();

    expect(runtime.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(current.get()).resolves.toEqual(runtime);
  });

  it("returns the same stored identity across helper instances", async () => {
    const backing = new Map<string, unknown>();
    const first = new CurrentContainerRuntimeIdentity(storage(backing));
    const started = await first.markStarted();
    const recreated = new CurrentContainerRuntimeIdentity(storage(backing));

    await expect(recreated.get()).resolves.toEqual(started);
  });

  it("creates a new UUID for each container runtime", async () => {
    const current = new CurrentContainerRuntimeIdentity(storage());

    const first = await current.markStarted();
    const second = await current.markStarted();

    expect(second.id).not.toBe(first.id);
  });

  it("clears only the runtime identity that stopped", async () => {
    const current = new CurrentContainerRuntimeIdentity(storage());
    const stale = await current.markStarted();
    const active = await current.markStarted();

    await current.clear(stale);
    await expect(current.get()).resolves.toEqual(active);

    await current.clear(active);
    await expect(current.get()).resolves.toBeNull();
  });
});
