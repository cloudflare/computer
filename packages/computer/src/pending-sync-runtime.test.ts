import type { ExecEvent, ShellRPC } from "@cloudflare/computer-rpc";
import { createSyncServer } from "@cloudflare/computer-rpc/server";
import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend";
import { Workspace } from "./workspace";

// A command's pending sync names the container runtime that ran it. These
// tests replace that container with an empty one, or run a second command,
// between the command and the pull() that is meant to finish its sync.

interface Runtime {
  readonly id: string;
  readonly remote: Database;
  readonly sync: ReturnType<typeof createSyncServer>;
}

function runtime(id: string): Runtime {
  const remote = new Database(new SQLiteTestStorage());
  initializeSchema(remote, () => 1000);
  return { id, remote, sync: createSyncServer(remote) };
}

// A container backend whose container can be swapped for an empty one.
// Each command writes the file its source names, on the container that
// runs it. `afterExit` runs when the consumer reads past the exit event,
// which is the moment between the command's output ending and its
// post-command pull starting.
function replaceableContainer() {
  let live = runtime("runtime-a");
  let failFetches = 0;
  let closeCurrent: (() => void) | undefined;
  let afterExit: (() => void) | undefined;
  const shell: ShellRPC = {
    async exec(input) {
      new SQLiteWorkspaceProvider(live.remote).writeFileSync(`/${input.source}`, input.source);
      const id = input.id ?? input.source;
      let sent = false;
      return {
        id,
        events: new ReadableStream<ExecEvent>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ id, seq: 1, name: "exit", code: 0 });
              return;
            }
            afterExit?.();
            afterExit = undefined;
            controller.close();
          },
        }),
      };
    },
    getExec: () => Promise.reject(new Error("not used")),
    killExec: () => Promise.reject(new Error("not used")),
    disposeExec: () => Promise.reject(new Error("not used")),
  };
  const backend: WorkspaceBackend = {
    id: "container",
    type: "fake",
    async connect(): Promise<BackendHandle> {
      const connected = live;
      const closed = new Promise<void>((resolve) => {
        closeCurrent = resolve;
      });
      // The next `failFetches` fetchChanges calls fail as a dropped
      // WebSocket would, while the container stays.
      const sync = new Proxy(connected.sync, {
        get(target, key) {
          if (key === "fetchChanges" && failFetches > 0) {
            return () => {
              failFetches -= 1;
              return Promise.reject(new Error("WebSocket closed"));
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return {
        rpc: { sync, shell },
        runtimeId: connected.id,
        closed,
        close: async () => {},
      };
    },
  };
  return {
    backend,
    // The container exits and the next connect starts an empty one with
    // a new runtime id. The old session's close event fires.
    replace() {
      live = runtime("runtime-b");
      closeCurrent?.();
    },
    replaceAfterNextExit() {
      afterExit = () => this.replace();
    },
    failNextFetches(count: number) {
      failFetches = count;
    },
  };
}

async function drainPull(ws: Workspace): Promise<void> {
  for await (const progress of ws.pull("container")) {
    if (progress.complete) return;
  }
}

// Lets the closed handler, which drops the cached handle, run.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("pending sync and the runtime that ran the command", () => {
  it("reports a deferred sync lost when its container was replaced before pull()", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // The command runs on runtime A, and its pull is deferred.
    const execution = await (await ws.runtime.exec("made.txt", { sync: "defer" })).result();
    expect(execution.sync.status).toBe("pending");

    // Runtime A is replaced by an empty B before anything pulls.
    container.replace();
    await tick();

    // pull() must not report the command's files synced: they were on A.
    await expect(drainPull(ws)).rejects.toMatchObject({
      name: "WorkspaceSyncLostError",
      code: "ESYNC_LOST",
      runtimeIds: ["runtime-a"],
    });
    expect(await ws.fs.readFile("/made.txt", "utf8").catch(() => undefined)).toBeUndefined();

    // The loss is reported once; pull() then syncs the live runtime.
    await expect(drainPull(ws)).resolves.toBeUndefined();
  });

  it("pulls a second deferred command's files before pull() completes", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // The first deferred command fixes a pull target.
    await (await ws.runtime.exec("first.txt", { sync: "defer" })).result();
    // The second runs on the same runtime and joins that pending pull.
    const second = await (await ws.runtime.exec("second.txt", { sync: "defer" })).result();
    expect(second.sync.status).toBe("pending");

    // The next pull() must finish both commands' syncs.
    await drainPull(ws);
    expect(await ws.fs.readFile("/first.txt", "utf8")).toBe("first.txt");
    expect(await ws.fs.readFile("/second.txt", "utf8")).toBe("second.txt");
  });

  it("reports an in-band sync lost when its pull reconnected to a replacement", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // The command's output ends, then runtime A is replaced before its
    // post-command pull runs, so the pull reconnects to B.
    container.replaceAfterNextExit();
    const execution = await (await ws.runtime.exec("made.txt")).result();
    expect(execution.sync.status).toBe("pending");

    // The next pull() must not report the command's files synced.
    await expect(drainPull(ws)).rejects.toMatchObject({
      code: "ESYNC_LOST",
      runtimeIds: ["runtime-a"],
    });
    await expect(drainPull(ws)).resolves.toBeUndefined();
  });

  it("completes an in-band sync when the runtime stays", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // Control: no replacement, so the in-band pull completes.
    const execution = await (await ws.runtime.exec("made.txt")).result();
    expect(execution.sync.status).toBe("complete");
    await drainPull(ws);
    expect(await ws.fs.readFile("/made.txt", "utf8")).toBe("made.txt");
  });

  it("finishes an in-band pending sync from the runtime that ran it", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // The post-command pull fails twice, its retry included, but the
    // container stays.
    container.failNextFetches(2);
    const execution = await (await ws.runtime.exec("made.txt")).result();
    expect(execution.sync.status).toBe("pending");

    // The next pull() reaches the same runtime and pulls the files.
    await drainPull(ws);
    expect(await ws.fs.readFile("/made.txt", "utf8")).toBe("made.txt");
  });

  it("remembers a pending sync across Durable Object eviction", async () => {
    const container = replaceableContainer();
    const storage = new SQLiteTestStorage();
    const before = new Workspace({ storage, backends: [container.backend] });
    await (await before.runtime.exec("made.txt", { sync: "defer" })).result();

    // The object is evicted, and the container is replaced while it is gone.
    container.replace();
    const after = new Workspace({ storage, backends: [container.backend] });

    await expect(drainPull(after)).rejects.toMatchObject({
      code: "ESYNC_LOST",
      runtimeIds: ["runtime-a"],
    });
  });

  it("does not report a deferred sync lost once a later pull covered it", async () => {
    const container = replaceableContainer();
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [container.backend] });

    // A deferred command, then a normal one whose post-command pull
    // brings in both commands' files.
    await (await ws.runtime.exec("deferred.txt", { sync: "defer" })).result();
    const later = await (await ws.runtime.exec("later.txt")).result();
    expect(later.sync.status).toBe("complete");
    expect(await ws.fs.readFile("/deferred.txt", "utf8")).toBe("deferred.txt");

    // The container is replaced afterwards: nothing pending was lost.
    container.replace();
    await tick();
    await expect(drainPull(ws)).resolves.toBeUndefined();
  });
});
