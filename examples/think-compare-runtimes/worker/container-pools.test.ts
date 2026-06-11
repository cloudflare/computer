import { describe, expect, test } from "vitest";
import { ContainerWarmPoolManager, type WarmPoolRuntime } from "./container-pool-manager";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

describe("ContainerWarmPoolManager", () => {
  test("assigns warmed containers to logical run ids", async () => {
    const runtime = createRuntime();
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 2,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();
    await expect(pool.getContainer("run-1")).resolves.toBe("warm-a");
    await expect(pool.getContainer("run-1")).resolves.toBe("warm-a");

    expect(runtime.started).toEqual(["warm-a", "warm-b"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: { "run-1": "warm-a" },
      warm: ["warm-b"],
    });
  });

  test("destroys released assignments and replenishes the warm target", async () => {
    const runtime = createRuntime();
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 1,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();
    await pool.getContainer("run-1");
    await pool.releaseContainer("run-1");
    await pool.refresh();

    expect(runtime.destroyed).toEqual(["warm-a"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      warm: ["warm-b"],
    });
  });

  test("does not assign one warm container to concurrent logical runs", async () => {
    const runtime = createRuntime();
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 1,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();
    const assigned = await Promise.all([pool.getContainer("run-1"), pool.getContainer("run-2")]);

    expect(new Set(assigned).size).toBe(2);
    expect(await pool.snapshot()).toMatchObject({
      assignments: { "run-1": assigned[0], "run-2": assigned[1] },
      warm: [],
    });
  });

  test("retries failed release destruction from refresh", async () => {
    const runtime = createRuntime();
    let failDestroy = true;
    runtime.destroyContainer = async (containerId) => {
      if (failDestroy) throw new Error("destroy failed");
      runtime.destroyed.push(containerId);
    };
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 1,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();
    await pool.getContainer("run-1");
    await pool.releaseContainer("run-1");

    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      releasing: ["warm-a"],
      warm: [],
    });

    failDestroy = false;
    await pool.refresh();

    expect(runtime.destroyed).toEqual(["warm-a"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      releasing: [],
      warm: ["warm-b"],
    });
  });

  test("keeps warm ownership when stale container destruction fails", async () => {
    const runtime = createRuntime();
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 1,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();
    runtime.running.delete("warm-a");
    runtime.destroyContainer = async () => {
      throw new Error("destroy failed");
    };
    await pool.refresh();

    expect(await pool.snapshot()).toMatchObject({
      releasing: ["warm-a"],
      warm: [],
    });
  });

  test("resets tracked containers before replenishing", async () => {
    const runtime = createRuntime();
    const storage = new MemoryStorage();
    await storage.put("container-warm-pool", {
      assignments: { "run-1": "assigned-a" },
      releasing: ["releasing-a"],
      warm: ["warm-a", "warm-b"],
    });
    for (const containerId of ["assigned-a", "releasing-a", "warm-a", "warm-b"]) {
      runtime.running.add(containerId);
    }
    const pool = new ContainerWarmPoolManager({
      storage,
      runtime,
      target: 2,
      createContainerId: nextId(["warm-c", "warm-d"]),
    });

    await pool.reset();
    await pool.refresh();

    expect(runtime.destroyed).toEqual(["releasing-a", "assigned-a", "warm-a", "warm-b"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      releasing: [],
      warm: ["warm-c", "warm-d"],
    });
  });

  test("does not replenish while cleanup is pending", async () => {
    const runtime = createRuntime();
    const storage = new MemoryStorage();
    await storage.put("container-warm-pool", {
      assignments: {},
      releasing: ["stuck-a"],
      warm: [],
    });
    runtime.destroyContainer = async () => {
      throw new Error("destroy failed");
    };
    const pool = new ContainerWarmPoolManager({
      storage,
      runtime,
      target: 2,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();

    expect(runtime.started).toEqual([]);
    expect(await pool.snapshot()).toMatchObject({
      releasing: ["stuck-a"],
      warm: [],
    });
  });

  test("scales warm containers down to the target", async () => {
    const runtime = createRuntime();
    const storage = new MemoryStorage();
    await storage.put("container-warm-pool", {
      assignments: {},
      releasing: [],
      warm: ["warm-a", "warm-b", "warm-c", "warm-d"],
    });
    for (const containerId of ["warm-a", "warm-b", "warm-c", "warm-d"]) {
      runtime.running.add(containerId);
    }
    const pool = new ContainerWarmPoolManager({
      storage,
      runtime,
      target: 2,
      createContainerId: nextId([]),
    });

    await pool.refresh();

    expect(runtime.destroyed).toEqual(["warm-c", "warm-d"]);
    expect(await pool.snapshot()).toMatchObject({
      releasing: [],
      warm: ["warm-a", "warm-b"],
    });
  });

  test("cleans up failed warm starts without throwing from refresh", async () => {
    const runtime = createRuntime();
    runtime.startContainer = async (containerId) => {
      runtime.started.push(containerId);
      runtime.running.add(containerId);
      throw new Error("start failed");
    };
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 2,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await expect(pool.refresh()).resolves.toBeUndefined();

    expect(runtime.started).toEqual(["warm-a"]);
    expect(runtime.destroyed).toEqual(["warm-a"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      releasing: [],
      warm: [],
    });
  });

  test("tracks failed warm starts when cleanup also fails", async () => {
    const runtime = createRuntime();
    runtime.startContainer = async (containerId) => {
      runtime.started.push(containerId);
      runtime.running.add(containerId);
      throw new Error("start failed");
    };
    runtime.destroyContainer = async () => {
      throw new Error("destroy failed");
    };
    const pool = new ContainerWarmPoolManager({
      storage: new MemoryStorage(),
      runtime,
      target: 2,
      createContainerId: nextId(["warm-a", "warm-b"]),
    });

    await pool.refresh();

    expect(runtime.started).toEqual(["warm-a"]);
    expect(await pool.snapshot()).toMatchObject({
      assignments: {},
      releasing: ["warm-a"],
      warm: [],
    });
  });
});

function createRuntime(): WarmPoolRuntime & {
  destroyed: string[];
  running: Set<string>;
  started: string[];
} {
  const running = new Set<string>();
  const started: string[] = [];
  const destroyed: string[] = [];
  return {
    destroyed,
    running,
    started,
    async startContainer(containerId) {
      started.push(containerId);
      running.add(containerId);
    },
    async destroyContainer(containerId) {
      destroyed.push(containerId);
      running.delete(containerId);
    },
    async isContainerRunning(containerId) {
      return running.has(containerId);
    },
    async keepContainerAlive() {},
  };
}

function nextId(ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (!id) throw new Error("out of ids");
    index += 1;
    return id;
  };
}
