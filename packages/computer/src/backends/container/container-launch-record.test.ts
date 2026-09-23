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

  test("changes when an environment value changes", async () => {
    const one = await launchRecordFor(spec({ env: { A: "1" } }));
    const two = await launchRecordFor(spec({ env: { A: "2" } }));

    expect(sameLaunch(one, two)).toBe(false);
  });

  test("changes when the internet flag changes", async () => {
    const one = await launchRecordFor(spec({ enableInternet: false }));
    const two = await launchRecordFor(spec({ enableInternet: true }));

    expect(sameLaunch(one, two)).toBe(false);
  });
});

// The fields below cannot be changed on a running container, so a
// container launched with one value cannot be adopted by a caller that
// asks for another. Each one has to reach the digest, or the adoption
// check silently hands back a container configured for someone else.
describe("launch-time-only options reach the digest", () => {
  test("a different instance size is not the same launch", async () => {
    const one = await launchRecordFor(spec({ instance: "standard-2" }));
    const two = await launchRecordFor(spec({ instance: "standard-4" }));

    expect(sameLaunch(one, two)).toBe(false);
  });

  test("a named tier and a custom size are not the same launch", async () => {
    const named = await launchRecordFor(spec({ instance: "standard-2" }));
    const custom = await launchRecordFor(
      spec({ instance: { vcpu: 1, memoryMib: 6144, diskMb: 12000 } }),
    );

    expect(sameLaunch(named, custom)).toBe(false);
  });

  test("a custom size digests by value, not by key order", async () => {
    const one = await launchRecordFor(
      spec({ instance: { vcpu: 16, memoryMib: 32768, diskMb: 64000 } }),
    );
    const two = await launchRecordFor(
      spec({ instance: { diskMb: 64000, vcpu: 16, memoryMib: 32768 } }),
    );

    expect(sameLaunch(one, two)).toBe(true);
  });

  test("a different image name is not the same launch", async () => {
    const one = await launchRecordFor(spec({ name: "app" }));
    const two = await launchRecordFor(spec({ name: "toolchain" }));

    expect(sameLaunch(one, two)).toBe(false);
  });
});

// A snapshot describes how a container was created, not a property of
// the running container: one restored from a snapshot is
// indistinguishable from one that was not. Digesting it would destroy
// and relaunch a healthy container every time the stored handle moved
// on, which is a relaunch nobody asked for.
describe("creation-time options stay out of the digest", () => {
  test("a different container snapshot is still the same launch", async () => {
    const one = await launchRecordFor(spec({ containerSnapshot: { id: "snap-1" } }));
    const two = await launchRecordFor(spec({ containerSnapshot: { id: "snap-2" } }));

    expect(sameLaunch(one, two)).toBe(true);
  });

  test("a different directory snapshot is still the same launch", async () => {
    const one = await launchRecordFor(spec({ directorySnapshots: [{ mountPoint: "/cache" }] }));
    const two = await launchRecordFor(spec({ directorySnapshots: [{ mountPoint: "/other" }] }));

    expect(sameLaunch(one, two)).toBe(true);
  });
});

describe("CurrentContainerLaunchRecord", () => {
  test("returns null before anything is stored", async () => {
    const record = new CurrentContainerLaunchRecord(fakeStorage());

    expect(await record.get()).toBeNull();
  });

  test("round-trips a stored record", async () => {
    const record = new CurrentContainerLaunchRecord(fakeStorage());
    const written = await launchRecordFor(spec({ instance: "standard-2", name: "app" }));

    await record.set(written);

    expect(await record.get()).toEqual(written);
  });
});
