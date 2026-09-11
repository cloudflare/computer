import { createSyncServer } from "@cloudflare/computer-rpc/server";
import { Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { Workspace } from "./workspace.js";

// The public surface the plan asks for: two restartable iterables that
// take no cursors and no budgets. These tests drive them the way an
// application would — from something that may not come back — so the
// interesting cases are "consume one block and stop" and "recreate the
// iterable and finish".

// A backend backed by a real in-process peer, so sync actually moves
// bytes rather than resolving against an empty fake.
function peerBackend(id: string): {
  backend: WorkspaceBackend;
  remote: Database;
  close: () => void;
} {
  const storage = new SQLiteTestStorage();
  const remote = new Database(storage);
  initializeSchema(remote, () => 1000);
  const sync = createSyncServer(remote);
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  const backend: WorkspaceBackend = {
    id,
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return {
        rpc: {
          sync,
          shell: {
            exec: notWired,
            getExec: notWired,
            killExec: notWired,
            disposeExec: notWired,
          },
        },
        close: async () => {},
      };
    },
  };
  return { backend, remote, close: () => storage.close() };
}

function seed(db: Database, count: number): void {
  const provider = new SQLiteWorkspaceProvider(db);
  for (let i = 0; i < count; i++) {
    provider.writeFileSync(`/f${String(i).padStart(3, "0")}.txt`, `content-${i}`);
  }
}

describe("Workspace.pull", () => {
  it("takes no cursor and no budget from the caller", async () => {
    const peer = peerBackend("fake");
    try {
      seed(peer.remote, 3);
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();

      // The only argument is which backend to talk to.
      const seen = [];
      for await (const progress of ws.pull()) seen.push(progress);

      expect(seen[seen.length - 1].complete).toBe(true);
      expect(await ws.fs.readFile("/f000.txt", "utf8")).toBe("content-0");
    } finally {
      peer.close();
    }
  });

  it("resumes from durable state when the iterable is recreated", async () => {
    const peer = peerBackend("fake");
    try {
      seed(peer.remote, 4);
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();

      // One block, then abandon the iterator the way an evicted
      // Durable Object would.
      const iterator = ws.pull()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);

      // A brand new iterable finishes the operation.
      for await (const progress of ws.pull()) {
        if (progress.complete) break;
      }

      expect(await ws.fs.readFile("/f003.txt", "utf8")).toBe("content-3");
    } finally {
      peer.close();
    }
  });

  it("reports the backend it synced against", async () => {
    const peer = peerBackend("container");
    try {
      seed(peer.remote, 1);
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();

      const seen = [];
      for await (const progress of ws.pull("container")) seen.push(progress);

      expect(seen[0].backend).toBe("container");
      expect(seen[0].direction).toBe("pull");
    } finally {
      peer.close();
    }
  });

  it("completes immediately when there is nothing to pull", async () => {
    const peer = peerBackend("fake");
    try {
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();

      const seen = [];
      for await (const progress of ws.pull()) seen.push(progress);

      expect(seen).toHaveLength(1);
      expect(seen[0].complete).toBe(true);
      expect(seen[0].entries).toBe(0);
    } finally {
      peer.close();
    }
  });
});

describe("Workspace.push", () => {
  it("ships local writes to the backend", async () => {
    const peer = peerBackend("fake");
    try {
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();
      await ws.fs.writeFile("/local.txt", "from the host");

      const seen = [];
      for await (const progress of ws.push()) seen.push(progress);

      expect(seen[seen.length - 1].complete).toBe(true);
      expect(seen[seen.length - 1].direction).toBe("push");
      const names = peer.remote
        .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1")
        .map((r) => r.name);
      expect(names).toContain("local.txt");
    } finally {
      peer.close();
    }
  });

  it("resumes a push from durable state", async () => {
    const peer = peerBackend("fake");
    try {
      const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [peer.backend] });
      await ws.ready();
      for (let i = 0; i < 4; i++) {
        await ws.fs.writeFile(`/f${i}.txt`, `content-${i}`);
      }

      const iterator = ws.push()[Symbol.asyncIterator]();
      await iterator.next();

      for await (const progress of ws.push()) {
        if (progress.complete) break;
      }

      const names = peer.remote
        .all<{ name: string }>("SELECT name FROM vfs_dirents WHERE parent_inode = 1")
        .map((r) => r.name);
      expect(names).toHaveLength(4);
    } finally {
      peer.close();
    }
  });
});

describe("sync block iterables and module backends", () => {
  it("completes without work for a backend that has no sync wire", async () => {
    const notWired = () => Promise.reject(new Error("exec not used in this test"));
    const module: import("./runtime/types.js").WorkspaceModuleBackend = {
      protocol: "module",
      id: "module",
      type: "module",
      async connect() {
        return {
          exec: notWired,
          getExec: notWired,
          killExec: notWired,
          disposeExec: notWired,
        };
      },
    };
    const ws = new Workspace({ storage: new SQLiteTestStorage(), backends: [module] });
    await ws.ready();

    const seen = [];
    for await (const progress of ws.pull()) seen.push(progress);

    expect(seen).toHaveLength(1);
    expect(seen[0].complete).toBe(true);
    expect(seen[0].entries).toBe(0);
  });
});
