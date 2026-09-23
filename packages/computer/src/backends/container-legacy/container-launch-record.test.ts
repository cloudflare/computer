import { describe, expect, test } from "vitest";

import {
  type ContainerLaunchSpec,
  CurrentContainerLaunchRecord,
  launchRecordFor,
  sameLaunch,
} from "./container-launch-record.js";

function spec(overrides: Partial<ContainerLaunchSpec> = {}): ContainerLaunchSpec {
  return {
    env: { PORT: "8080", MOUNT_POINT: "/workspace" },
    enableInternet: false,
    ...overrides,
  };
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  return {
    values,
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
}

describe("launchRecordFor", () => {
  test("is stable regardless of the order keys were written in", async () => {
    const one = await launchRecordFor(spec({ env: { A: "1", B: "2" } }));
    const two = await launchRecordFor(spec({ env: { B: "2", A: "1" } }));

    expect(one.envDigest).toBe(two.envDigest);
    expect(sameLaunch(one, two)).toBe(true);
  });

  test("changes when a value changes", async () => {
    const before = await launchRecordFor(spec({ env: { FUSE_MOUNT: "auto" } }));
    const after = await launchRecordFor(spec({ env: { FUSE_MOUNT: "none" } }));

    expect(sameLaunch(before, after)).toBe(false);
  });

  test("changes when a variable is added", async () => {
    const before = await launchRecordFor(spec({ env: { PORT: "8080" } }));
    const after = await launchRecordFor(spec({ env: { PORT: "8080", EXTRA: "" } }));

    expect(sameLaunch(before, after)).toBe(false);
  });

  test("distinguishes the internet flag", async () => {
    // This is the egress case: a pool that launches with the internet
    // enabled must not be adopted by a workspace that asked for it off.
    const off = await launchRecordFor(spec({ enableInternet: false }));
    const on = await launchRecordFor(spec({ enableInternet: true }));

    expect(sameLaunch(off, on)).toBe(false);
  });

  test("does not carry the environment in the clear", async () => {
    // containerEnv is consumer-supplied and may hold their own secrets,
    // so only a digest is persisted.
    const record = await launchRecordFor(spec({ env: { API_TOKEN: "hunter2" } }));

    expect(JSON.stringify(record)).not.toContain("hunter2");
    expect(record.envDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("CurrentContainerLaunchRecord", () => {
  test("round-trips a record", async () => {
    const storage = fakeStorage();
    const store = new CurrentContainerLaunchRecord(storage);
    const record = await launchRecordFor(spec());

    await store.set(record);

    expect(await store.get()).toEqual(record);
  });

  test("reads null before anything has been launched", async () => {
    expect(await new CurrentContainerLaunchRecord(fakeStorage()).get()).toBeNull();
  });

  test("reads null when a caller launched the container behind our back", async () => {
    // A container started outside this API leaves no record. Returning
    // null is what makes the adoption check relaunch it rather than
    // trust it.
    const storage = fakeStorage({ "computer:container-runtime-identity": { id: "abc" } });

    expect(await new CurrentContainerLaunchRecord(storage).get()).toBeNull();
  });
});
