import { createSyncServer } from "@cloudflare/computer-rpc/server";
import {
  Database,
  initializeSchema,
  readOperation,
  SQLiteWorkspaceProvider,
} from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { Workspace } from "./workspace.js";

// Deferred synchronization used to need a host-supplied retry
// scheduler: the host persisted an intent, set its own alarm, and
// called back into retryPendingSync. The durable operation row makes
// that indirection unnecessary. A deferred exec captures the pull
// target, and any later caller resumes it by iterating pull().

function peerBackend(id: string): {
  backend: WorkspaceBackend;
  remote: Database;
  close: () => void;
} {
  const storage = new SQLiteTestStorage();
  const remote = new Database(storage);
  initializeSchema(remote, () => 1000);
  const sync = createSyncServer(remote);
  const execId = () => `${id}-exec`;
  const shell: import("@cloudflare/computer-rpc").ShellRPC = {
    async exec(input) {
      const eid = input.id ?? execId();
      return {
        id: eid,
        events: new ReadableStream<import("@cloudflare/computer-rpc").ExecEvent>({
          start(controller) {
            controller.enqueue({ id: eid, seq: 1, name: "exit", code: 0 });
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
    id,
    type: "fake",
    async connect(): Promise<BackendHandle> {
      return { rpc: { sync, shell }, close: async () => {} };
    },
  };
  return { backend, remote, close: () => storage.close() };
}

describe("deferred synchronization without a host scheduler", () => {
  it("leaves a resumable pull operation after a deferred exec", async () => {
    const peer = peerBackend("fake");
    try {
      const provider = new SQLiteWorkspaceProvider(peer.remote);
      provider.writeFileSync("/produced.txt", "by the command");

      const ws = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [peer.backend],
      });
      await ws.ready();

      // A deferred exec returns without draining the pull.
      const handle = await ws.runtime.exec("true", { sync: "defer" });
      await handle.result();

      // The application resumes on its own schedule. No retry
      // scheduler, no host-persisted intent.
      for await (const progress of ws.pull()) {
        if (progress.complete) break;
      }

      expect(await ws.fs.readFile("/produced.txt", "utf8")).toBe("by the command");
    } finally {
      peer.close();
    }
  });

  it("does not require a retryScheduler to defer", async () => {
    const peer = peerBackend("fake");
    try {
      const ws = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [peer.backend],
      });
      await ws.ready();

      // Previously this threw without a configured retryScheduler.
      const handle = await ws.runtime.exec("true", { sync: "defer" });
      await expect(handle.result()).resolves.toBeDefined();
    } finally {
      peer.close();
    }
  });

  it("reports a deferred pull as pending rather than complete", async () => {
    const peer = peerBackend("fake");
    try {
      const provider = new SQLiteWorkspaceProvider(peer.remote);
      provider.writeFileSync("/produced.txt", "by the command");

      const ws = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [peer.backend],
      });
      await ws.ready();

      const handle = await ws.runtime.exec("true", { sync: "defer" });
      const execution = await handle.result();

      expect(execution.sync.status).toBe("pending");
      // Nothing applied yet: that is the point of deferring.
      expect(execution.sync.applied).toBe(0);
    } finally {
      peer.close();
    }
  });

  it("converges a deferred pull driven one block at a time", async () => {
    const peer = peerBackend("fake");
    try {
      const provider = new SQLiteWorkspaceProvider(peer.remote);
      for (let i = 0; i < 5; i++) {
        provider.writeFileSync(`/f${i}.txt`, `content-${i}`);
      }

      const ws = new Workspace({
        storage: new SQLiteTestStorage(),
        backends: [peer.backend],
      });
      await ws.ready();
      const handle = await ws.runtime.exec("true", { sync: "defer" });
      await handle.result();

      // One block per "alarm", each from a fresh iterable.
      for (let i = 0; i < 20; i++) {
        const iterator = ws.pull()[Symbol.asyncIterator]();
        const { value, done } = await iterator.next();
        if (done || value.complete) break;
      }

      expect(await ws.fs.readFile("/f4.txt", "utf8")).toBe("content-4");
      // Completed operations leave no row behind.
      expect(readOperation(ws.db, "fake", "pull")).toBeUndefined();
    } finally {
      peer.close();
    }
  });
});
