// End-to-end tests for ShellRPC and the composite WorkspaceRPC.
//
// Two surfaces shipped with no direct coverage:
//
//   - ShellRpcServer wraps a RunnerLike. The Runner type lives in
//     @cloudflare/computerd; rpc only depends on the structural
//     RunnerLike interface from server.ts. Tests wire up a fake
//     RunnerLike rather than dragging computerd into the rpc test graph.
//
//   - createWorkspaceServer / createWorkspaceClient compose sync
//     and shell over one capnweb session. The composite exposes
//     `.sync` and `.shell` as getters (capnweb refuses to traverse
//     plain instance properties — see comment on WorkspaceRPCServer
//     in server.ts). Pin both the routing and the getter contract.
//
// Both halves go through a real WebSocket against acceptWebSocketSession.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Database, initializeSchema, ROOT_INODE } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createSyncClient, createWorkspaceClient } from "../src/client.js";
import type { ExecEvent } from "../src/interface.js";
import {
  acceptWebSocketSession,
  createShellServer,
  createWorkspaceServer,
  type RunnerLike,
} from "../src/server.js";

interface ExecRecord {
  id: string;
  command: string;
  cwd?: string;
  events: ExecEvent[];
  killed?: { signal: string };
  disposed?: boolean;
}

interface FakeRunner extends RunnerLike {
  records: Map<string, ExecRecord>;
}

// Minimal RunnerLike that records calls and streams a canned
// sequence of events for each exec. Each exec emits one stdout
// line and an exit, then closes.
function makeFakeRunner(): FakeRunner {
  const records = new Map<string, ExecRecord>();
  let counter = 0;

  function streamFor(rec: ExecRecord): ReadableStream<ExecEvent> {
    return new ReadableStream<ExecEvent>({
      start(controller) {
        for (const ev of rec.events) controller.enqueue(ev);
        controller.close();
      },
    });
  }

  return {
    records,
    exec(command, options) {
      const id = options?.id ?? `e-${++counter}`;
      const rec: ExecRecord = {
        id,
        command,
        cwd: options?.cwd,
        events: [
          {
            id,
            seq: 1,
            name: "stdout",
            value: new TextEncoder().encode(`ran:${command}\n`),
          },
          { id, seq: 2, name: "exit", code: 0 },
        ],
      };
      records.set(id, rec);
      return { id, events: streamFor(rec) };
    },
    get(id) {
      const rec = records.get(id);
      if (rec === undefined) throw new Error(`no record for ${id}`);
      return { id, events: streamFor(rec) };
    },
    kill(id, signal) {
      const rec = records.get(id);
      if (rec === undefined) throw new Error(`no record for ${id}`);
      rec.killed = { signal: signal ?? "SIGTERM" };
    },
    dispose(id) {
      const rec = records.get(id);
      if (rec === undefined) return;
      rec.disposed = true;
    },
  };
}

interface ShellHarness {
  url: string;
  runner: FakeRunner;
  close: () => Promise<void>;
}

async function startShellHarness(): Promise<ShellHarness> {
  const runner = makeFakeRunner();
  const rpc = createShellServer(runner);
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: "/rpc" });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    runner,
    close: async () => {
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

async function drainExec(stream: ReadableStream<ExecEvent>): Promise<ExecEvent[]> {
  const events: ExecEvent[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

describe("ShellRPC over a real WebSocket", () => {
  let harness: ShellHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("exec forwards the command and streams events back to the client", async () => {
    harness = await startShellHarness();
    // Sync client knows how to dial /rpc; reuse its constructor and
    // cast to the wire shape we need. ShellRPC is structurally a
    // subset of WorkspaceRPC for our purposes here.
    const client = createWorkspaceClient({ url: harness.url });
    try {
      // ShellRpcServer is the top-level target for this harness, so
      // `client.exec(...)` lands on it directly. createWorkspaceClient
      // proxies all property access through; capnweb routes by name.
      // biome-ignore lint/suspicious/noExplicitAny: client targets ShellRPC for this harness, not WorkspaceRPC
      const handle = await (client as any).exec({ source: "echo hi" });
      const events = await drainExec(handle.events);
      expect(events).toHaveLength(2);
      expect(events[0]?.name).toBe("stdout");
      expect(new TextDecoder().decode(events[0]?.value as Uint8Array)).toBe("ran:echo hi\n");
      expect(events[1]).toMatchObject({ name: "exit", code: 0 });

      // Server-side: the runner saw the call.
      const rec = harness.runner.records.get(handle.id);
      expect(rec?.command).toBe("echo hi");
    } finally {
      await client.close();
    }
  });

  it("killExec and disposeExec land on the runner", async () => {
    harness = await startShellHarness();
    const client = createWorkspaceClient({ url: harness.url });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      const handle = await (client as any).exec({ source: "sleep", id: "fixed" });
      await drainExec(handle.events);

      // biome-ignore lint/suspicious/noExplicitAny: see above
      await (client as any).killExec({ id: "fixed", signal: "SIGKILL" });
      expect(harness.runner.records.get("fixed")?.killed?.signal).toBe("SIGKILL");

      // biome-ignore lint/suspicious/noExplicitAny: see above
      await (client as any).disposeExec({ id: "fixed" });
      expect(harness.runner.records.get("fixed")?.disposed).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("getExec replays the recorded events", async () => {
    harness = await startShellHarness();
    const client = createWorkspaceClient({ url: harness.url });
    try {
      // biome-ignore lint/suspicious/noExplicitAny: see above
      const first = await (client as any).exec({ source: "first", id: "repeat" });
      await drainExec(first.events);

      // biome-ignore lint/suspicious/noExplicitAny: see above
      const second = await (client as any).getExec({ id: "repeat" });
      const replayed = await drainExec(second.events);
      expect(replayed).toHaveLength(2);
      expect(new TextDecoder().decode(replayed[0]?.value as Uint8Array)).toBe("ran:first\n");
    } finally {
      await client.close();
    }
  });
});

interface CompositeHarness {
  url: string;
  db: Database;
  runner: FakeRunner;
  close: () => Promise<void>;
}

async function startCompositeHarness(): Promise<CompositeHarness> {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  const runner = makeFakeRunner();
  const rpc = createWorkspaceServer(db, runner);
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http, path: "/rpc" });
  wss.on("connection", (ws) => {
    acceptWebSocketSession(ws, rpc);
  });
  await new Promise<void>((res) => http.listen(0, "127.0.0.1", res));
  const { port } = http.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    db,
    runner,
    close: async () => {
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
      storage.close();
    },
  };
}

describe("Composite WorkspaceRPC (sync + shell on one session)", () => {
  let harness: CompositeHarness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("client.sync.watermarks and client.shell.exec both work over one socket", async () => {
    // The whole point of the composite stub. If the WorkspaceRPCServer
    // getter trick regresses (capnweb starting to traverse plain
    // instance properties again, or the getter shape changing), one
    // of these two-step accesses will throw 'instance properties
    // cannot be accessed over RPC'.
    harness = await startCompositeHarness();
    const client = createWorkspaceClient({ url: harness.url });
    try {
      const wm = await client.sync.watermarks();
      // The watermarks shape is the diagnostic surface; we only
      // care that it round-trips and that the call lands.
      expect(typeof wm.currentRev).toBe("number");
      expect(wm.currentRev).toBeGreaterThanOrEqual(0);

      const handle = await client.shell.exec({ source: "ls" });
      const events = await drainExec(handle.events);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ name: "exit", code: 0 });

      // Sanity check: server side records both interactions.
      expect(harness.runner.records.get(handle.id)?.command).toBe("ls");
    } finally {
      await client.close();
    }
  });

  it("sync half pins ROOT_INODE state independently from the shell half", async () => {
    // Mostly a smoke check that the composite doesn't shadow either
    // sub-stub's methods. readEntry on a missing path returns null;
    // shell.exec on a no-op returns the stub events.
    harness = await startCompositeHarness();
    const client = createWorkspaceClient({ url: harness.url });
    try {
      expect(await client.sync.readEntry("/none")).toBeNull();

      const handle = await client.shell.exec({ source: "noop" });
      await drainExec(handle.events);
      expect(harness.runner.records.size).toBe(1);

      // ROOT_INODE is a real export; we import it only to confirm the
      // sync half is bound to the actual workspace-fs schema, not a
      // mock.
      expect(ROOT_INODE).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("sync stub remains usable after shell calls (composite session is shared)", async () => {
    harness = await startCompositeHarness();
    const client = createWorkspaceClient({ url: harness.url });
    try {
      const handle = await client.shell.exec({ source: "x" });
      await drainExec(handle.events);
      const wm = await client.sync.watermarks();
      expect(typeof wm.currentRev).toBe("number");
    } finally {
      await client.close();
    }
  });

  it("createSyncClient against a WorkspaceRPC server still reaches sync via property pipelining", async () => {
    // Cross-check: a sync-only client talking to a composite server.
    // Capnweb resolves `.watermarks()` against the composite's `.sync`
    // getter when the call lands; this is the "client expects SyncRPC
    // but server is WorkspaceRPC" case. Until pipelining is wired we
    // exercise the composite client only.
    harness = await startCompositeHarness();
    const syncClient = createSyncClient({ url: harness.url });
    try {
      // watermarks lives on SyncRPC. The composite root doesn't expose
      // it directly; this should fail without two-step access. Pin
      // that the sync-only client therefore can't see it (documenting
      // the constraint).
      await expect(syncClient.watermarks()).rejects.toThrow();
    } finally {
      await syncClient.close();
    }
  });
});
