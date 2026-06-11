import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  containerBackendOptions,
  getSandbox,
  runRealThinkTurn,
  runtimeOrder,
  warmPoolReleases,
  workerBackendOptions,
  workspaceOptions,
} = vi.hoisted(() => ({
  containerBackendOptions: [] as Array<Record<string, unknown>>,
  getSandbox: vi.fn(),
  runRealThinkTurn: vi.fn(),
  runtimeOrder: [] as string[],
  warmPoolReleases: [] as string[],
  workerBackendOptions: [] as Array<Record<string, unknown>>,
  workspaceOptions: [] as Array<{ backends?: Array<{ id?: string }> }>,
}));

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  getSandbox,
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: unknown,
    ) {}
  },
}));

vi.mock("@cloudflare/workspace", () => ({
  Workspace: class {
    readonly fs = {
      mkdir: async () => {},
      readFile: async () => "",
      writeFile: async () => {},
    };
    readonly shell = {
      exec: async () => ({
        result: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    };

    constructor(options: { backends?: Array<{ id?: string }> }) {
      workspaceOptions.push(options);
    }

    async close() {}
    async ready() {}
  },
  WorkspaceProxy: class {},
}));

vi.mock("@cloudflare/workspace/backends/container", () => ({
  CloudflareContainerBackend: class {
    readonly id: string;

    constructor(options: Record<string, unknown>) {
      this.id = typeof options.id === "string" ? options.id : "cloudflare-container";
      containerBackendOptions.push(options);
    }

    async handleFetch() {
      return new Response(null, { status: 404 });
    }
  },
}));

vi.mock("@cloudflare/workspace/backends/worker", () => ({
  WorkerBackend: class {
    readonly id: string;

    constructor(options: Record<string, unknown>) {
      this.id = typeof options.id === "string" ? options.id : "worker";
      workerBackendOptions.push(options);
    }
  },
}));

vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
}));

vi.mock("partyserver", () => ({
  getServerByName: vi.fn(),
}));

vi.mock("./real-turn", () => ({
  runRealThinkTurn,
}));

vi.mock("../container-pools", () => ({
  containerSleepAfter: (env: { CONTAINER_SLEEP_AFTER?: string }) =>
    env.CONTAINER_SLEEP_AFTER ?? "2m",
  getWarmPoolHandle: () => ({
    async getContainer() {
      return "sandbox-physical-1";
    },
    async releaseContainer(runId: string) {
      warmPoolReleases.push(runId);
    },
  }),
}));

import { type RuntimeThinkAgentEnv, SandboxThinkAgent, WorkspaceThinkAgent } from "./agents";

describe("WorkspaceThinkAgent", () => {
  beforeEach(() => {
    containerBackendOptions.length = 0;
    workerBackendOptions.length = 0;
    workspaceOptions.length = 0;
    runRealThinkTurn.mockReset();
  });

  test("constructs a Workspace with worker shell and container backends", async () => {
    runRealThinkTurn.mockImplementation(async () => {});
    const agent = new TestWorkspaceThinkAgent(
      {
        id: { toString: () => "workspace-agent-id" },
        storage: {},
      } as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        WorkspaceContainerHost: {
          get: () => ({}),
          idFromName: (name: string) => name,
        } as unknown as DurableObjectNamespace,
        WorkspaceWarmPool: {} as DurableObjectNamespace,
        LOADER: {},
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.run({ runId: "run-1", fixture: { root: "/workspace/repo", task: "", files: [] } });

    expect(workerBackendOptions).toHaveLength(1);
    expect(workerBackendOptions[0]).toMatchObject({
      id: "shell",
      workspace: { binding: "WorkspaceThinkAgent", id: "workspace-agent-id" },
    });
    expect(containerBackendOptions).toHaveLength(1);
    expect(containerBackendOptions[0]).toMatchObject({
      id: "container",
      workspace: { binding: "WorkspaceThinkAgent", id: "workspace-agent-id" },
    });
    expect(workspaceOptions[0]?.backends?.map((backend) => backend.id)).toEqual([
      "shell",
      "container",
    ]);
  });
});

describe("SandboxThinkAgent", () => {
  test("does not cap model tool-loop steps", () => {
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
      } as unknown as RuntimeThinkAgentEnv,
    );

    expect((agent as unknown as { maxSteps: number }).maxSteps).toBe(Number.POSITIVE_INFINITY);
  });

  beforeEach(() => {
    getSandbox.mockReset();
    runRealThinkTurn.mockReset();
    runtimeOrder.length = 0;
  });

  test("uses one Sandbox session for seeding, files, and exec", async () => {
    const calls: string[] = [];
    runRealThinkTurn.mockImplementation(async ({ adapter }) => {
      runtimeOrder.push("think");
      await adapter.files.read("/workspace/repo/package.json");
      await adapter.exec("pwd", { cwd: "/workspace/repo" });
    });
    const session = {
      id: "run-1-sandbox-agent",
      async mkdir(path: string) {
        calls.push(`session mkdir ${path}`);
      },
      async writeFile(path: string) {
        runtimeOrder.push(`seed:${path}`);
        calls.push(`session write ${path}`);
      },
      async readFile(path: string) {
        calls.push(`session read ${path}`);
        return { content: "{}\n" };
      },
      async exec(command: string, options?: { cwd?: string }) {
        calls.push(`session exec ${command} ${options?.cwd}`);
        return { exitCode: 0, stdout: "/workspace/repo\n", stderr: "" };
      },
    };
    getSandbox.mockReturnValue({
      async createSession(options?: { id?: string; cwd?: string }) {
        calls.push(`createSession ${options?.id} ${options?.cwd}`);
        return session;
      },
      async deleteSession(sessionId: string) {
        calls.push(`deleteSession ${sessionId}`);
      },
      async mkdir(path: string) {
        calls.push(`sandbox mkdir ${path}`);
      },
      async writeFile(path: string) {
        calls.push(`sandbox write ${path}`);
      },
    });
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
        CONTAINER_SLEEP_AFTER: "2m",
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.run({
      runId: "run-1",
      fixture: {
        root: "/workspace/repo",
        task: "test task",
        files: [{ path: "package.json", contents: "{}\n" }],
      },
    });

    expect(getSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "sandbox-physical-1",
      expect.objectContaining({ sleepAfter: "2m" }),
    );
    expect(calls).toEqual([
      "createSession run-1-sandbox-agent /",
      "session mkdir /workspace/repo",
      "session write /workspace/repo/package.json",
      "session read /workspace/repo/package.json",
      "session exec test -d /workspace/repo && test -f /workspace/repo/package.json undefined",
      "session read /workspace/repo/package.json",
      "session exec pwd /workspace/repo",
      "deleteSession run-1-sandbox-agent",
    ]);
    expect(runtimeOrder).toEqual(["seed:/workspace/repo/package.json", "think"]);
  });

  test("fails before Think starts when the Sandbox seed is not shell-visible", async () => {
    runRealThinkTurn.mockImplementation(() => {
      throw new Error("Think should not start");
    });
    getSandbox.mockReturnValue({
      async createSession() {
        return {
          id: "run-1-sandbox-agent",
          async mkdir() {},
          async writeFile() {},
          async readFile() {
            return { content: "{}\n" };
          },
          async exec() {
            return { exitCode: 1, stdout: "", stderr: "missing repo" };
          },
        };
      },
      async deleteSession() {},
    });
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
      } as unknown as RuntimeThinkAgentEnv,
    );

    await expect(
      agent.run({
        runId: "run-1",
        fixture: {
          root: "/workspace/repo",
          task: "test task",
          files: [{ path: "package.json", contents: "{}\n" }],
        },
      }),
    ).rejects.toThrow("Sandbox fixture seed is not visible to exec");
    expect(runRealThinkTurn).not.toHaveBeenCalled();
  });

  test("releases Sandbox warm-pool assignments during runtime cleanup", async () => {
    warmPoolReleases.length = 0;
    getSandbox.mockReturnValue({
      async createSession() {
        return {
          id: "run-1-sandbox-agent",
          async mkdir() {},
          async writeFile() {},
          async readFile() {
            return { content: "" };
          },
          async exec() {
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        };
      },
      async deleteSession() {},
    });
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
      } as unknown as RuntimeThinkAgentEnv,
    );

    await agent.run({
      runId: "run-1",
      fixture: { root: "/workspace/repo", task: "", files: [] },
    });

    expect(warmPoolReleases).toEqual(["run-1"]);
  });
  test("throws when a completed submission has no assistant text", async () => {
    const agent = new TestSandboxThinkAgent(
      {} as DurableObjectState,
      {
        AI: {} as Ai,
        CompareRun: {} as DurableObjectNamespace,
        Sandbox: {} as DurableObjectNamespace,
        SandboxWarmPool: {} as DurableObjectNamespace,
      } as unknown as RuntimeThinkAgentEnv,
    );
    Object.defineProperty(agent, "messages", {
      configurable: true,
      value: [{ id: "message-1", role: "assistant", parts: [{ type: "text", text: "   " }] }],
    });
    agent.inspectSubmission = async () => ({
      submissionId: "submission-1",
      status: "completed",
      createdAt: Date.now(),
    });

    await expect(agent.awaitAssistantText("submission-1")).rejects.toThrow(
      "Think turn completed without assistant text",
    );
  });
});

class TestWorkspaceThinkAgent extends WorkspaceThinkAgent {
  run(config: Parameters<WorkspaceThinkAgent["runComparison"]>[0]) {
    return this.runWithRuntime(config, {
      record: () => ({}) as never,
    });
  }
}

class TestSandboxThinkAgent extends SandboxThinkAgent {
  run(config: Parameters<SandboxThinkAgent["runComparison"]>[0]) {
    return this.runWithRuntime(config, {
      record: () => ({}) as never,
    });
  }
}
