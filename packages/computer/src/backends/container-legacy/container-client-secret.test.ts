import { describe, expect, test } from "vitest";

import { ContainerClientSecret } from "./container-client-secret.js";

function fakeStorage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  let writes = 0;
  return {
    writes: () => writes,
    values,
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      writes++;
      values.set(key, value);
    },
  };
}

describe("ContainerClientSecret", () => {
  test("generates 32 hex characters on first use", async () => {
    const storage = fakeStorage();
    const secret = await new ContainerClientSecret(storage).ensure();

    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(storage.writes()).toBe(1);
  });

  test("returns the stored value on later calls without rewriting it", async () => {
    const storage = fakeStorage();
    const store = new ContainerClientSecret(storage);

    const first = await store.ensure();
    const second = await store.ensure();

    expect(second).toBe(first);
    expect(storage.writes()).toBe(1);
  });

  test("a reconstructed instance reuses the persisted value", async () => {
    // This is the case that matters: a durable object rebuilt against a
    // container that is still running has to present the secret that
    // container was launched with.
    const storage = fakeStorage();
    const before = await new ContainerClientSecret(storage).ensure();

    const after = await new ContainerClientSecret(storage).ensure();

    expect(after).toBe(before);
  });

  test("two workspaces do not share a secret", async () => {
    const one = await new ContainerClientSecret(fakeStorage()).ensure();
    const two = await new ContainerClientSecret(fakeStorage()).ensure();

    expect(one).not.toBe(two);
  });

  test("replaces a stored value that is empty", async () => {
    const storage = fakeStorage({ "computer:container-client-secret": "" });

    const secret = await new ContainerClientSecret(storage).ensure();

    expect(secret).toMatch(/^[0-9a-f]{32}$/);
  });
});
