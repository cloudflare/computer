import { describe, expect, it } from "vitest";

import {
  type BrowserCommandHost,
  type BrowserRuntimeHandle,
  defineBrowserCommand,
} from "./command.js";

interface ExecCall {
  source: string;
  options: {
    backend?: string;
    cwd?: string;
    input?: unknown;
    timeoutMs?: number;
    encoding?: "utf8";
  };
}

interface HostOptions {
  files?: Record<string, string>;
  result?: Partial<Awaited<ReturnType<BrowserRuntimeHandle["result"]>>>;
  failExec?: Error;
  /** Model a task that never settles on its own, so only a kill ends it. */
  neverSettles?: boolean;
  failKill?: Error;
  /** Model the promise-like id property of a handle received over Workers RPC. */
  rpcHandleId?: boolean;
  failHandleId?: Error;
  /** Model a write that leaves the file behind and then fails. */
  failWriteAfterCreating?: Error;
}

function createHost(options: HostOptions = {}) {
  const files = new Map(Object.entries(options.files ?? {}));
  const execCalls: ExecCall[] = [];
  const killed: string[] = [];
  const removed: string[] = [];
  let disposed = 0;
  let handle: BrowserRuntimeHandle | undefined;

  const host: BrowserCommandHost = {
    fs: {
      async exists(path) {
        return files.has(path);
      },
      async writeFile(path, content) {
        files.set(path, String(content));
        if (options.failWriteAfterCreating) throw options.failWriteAfterCreating;
      },
      async rm(path) {
        removed.push(path);
        files.delete(path);
      },
    },
    runtime: {
      async exec(source, execOptions) {
        execCalls.push({ source, options: execOptions });
        if (options.failExec) throw options.failExec;
        handle = {
          id: options.failHandleId
            ? Promise.reject(options.failHandleId)
            : options.rpcHandleId
              ? Promise.resolve("exec-1")
              : "exec-1",
          async result() {
            if (options.neverSettles) await new Promise(() => {});
            return {
              status: "completed",
              exitCode: 0,
              stdout: "",
              stderr: "",
              ...options.result,
            } as Awaited<ReturnType<BrowserRuntimeHandle["result"]>>;
          },
          [Symbol.dispose]() {
            disposed += 1;
          },
        };
        return handle;
      },
      async killExec(id) {
        killed.push(id);
        if (options.failKill) throw options.failKill;
      },
    },
  };

  return {
    host,
    execCalls,
    killed,
    removed,
    files,
    get disposed() {
      return disposed;
    },
  };
}

function context(overrides: Partial<Parameters<typeof runCommand>[2]> = {}) {
  return { cwd: "/workspace", env: new Map<string, string>(), stdin: "", ...overrides };
}

async function runCommand(
  host: BrowserCommandHost,
  argv: string[],
  ctx: { cwd: string; env: Map<string, string>; stdin: string; signal?: AbortSignal },
) {
  const command = defineBrowserCommand(host);
  const execute = (command as { execute: (args: string[], ctx: unknown) => Promise<unknown> })
    .execute;
  return (await execute(argv, ctx)) as { stdout: string; stderr: string; exitCode: number };
}

describe("browser command", () => {
  it("dispatches a workspace task module to the JavaScript backend", async () => {
    const harness = createHost({
      files: { "/workspace/tasks/run.js": "export default () => ({})" },
      result: { value: { title: "Example" } },
    });

    const result = await runCommand(
      harness.host,
      ["puppeteer", "--url", "https://example.com/", "tasks/run.js"],
      context(),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ title: "Example" });
    expect(harness.execCalls).toHaveLength(1);
    const [call] = harness.execCalls;
    expect(call.source).toContain('import task from "./run.js";');
    expect(call.options.cwd).toBe("/workspace/tasks");
    expect(call.options.backend).toBe("worker-javascript");
    expect(call.options.input).toEqual({ url: "https://example.com/" });
    expect(call.source).toContain('"example.com"');
    expect(harness.disposed).toBe(1);
  });

  it("merges structured input with the target URL", async () => {
    const harness = createHost({ files: { "/workspace/run.js": "" } });

    await runCommand(
      harness.host,
      ["puppeteer", "--url", "https://example.com/", "--input", '{"depth":2}', "run.js"],
      context(),
    );

    expect(harness.execCalls[0].options.input).toEqual({
      depth: 2,
      url: "https://example.com/",
    });
  });

  it("leaves the session unconfined when no URL is given", async () => {
    const harness = createHost({ files: { "/workspace/run.js": "" } });

    await runCommand(harness.host, ["puppeteer", "run.js"], context());

    expect(harness.execCalls[0].source).not.toContain("allowedDomains");
  });

  it("forwards the execution timeout", async () => {
    const harness = createHost({ files: { "/workspace/run.js": "" } });

    await runCommand(harness.host, ["puppeteer", "--timeout", "1000", "run.js"], context());

    expect(harness.execCalls[0].options.timeoutMs).toBe(1000);
  });

  it("runs a task read from stdin and removes the temporary module", async () => {
    const harness = createHost({ result: { value: "ok" } });

    const result = await runCommand(
      harness.host,
      ["puppeteer", "--url", "https://example.com/", "--stdin"],
      context({ stdin: "export default () => 'ok'" }),
    );

    expect(result.exitCode).toBe(0);
    expect(harness.removed).toHaveLength(1);
    expect(harness.removed[0]).toMatch(/^\/workspace\/\.browser-task-[0-9a-f-]+\.js$/);
    expect(harness.files.has(harness.removed[0])).toBe(false);
  });

  it("removes the temporary module when the task fails", async () => {
    const harness = createHost({ failExec: new Error("backend exploded") });

    const result = await runCommand(
      harness.host,
      ["puppeteer", "--stdin"],
      context({ stdin: "export default () => 1" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("backend exploded");
    expect(harness.removed).toHaveLength(1);
  });

  it("rejects an empty stdin task", async () => {
    const harness = createHost();

    const result = await runCommand(harness.host, ["puppeteer", "--stdin"], context());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("stdin");
    expect(harness.execCalls).toHaveLength(0);
  });

  it("reports a task module that is not in the workspace", async () => {
    const harness = createHost();

    const result = await runCommand(harness.host, ["puppeteer", "missing.js"], context());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("/workspace/missing.js");
    expect(harness.execCalls).toHaveLength(0);
  });

  it("forwards task output and its exit code", async () => {
    const harness = createHost({
      files: { "/workspace/run.js": "" },
      result: { exitCode: 3, stdout: "log line\n", stderr: "warning\n", value: undefined },
    });

    const result = await runCommand(harness.host, ["puppeteer", "run.js"], context());

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("log line\n");
    expect(result.stderr).toBe("warning\n");
  });

  it("separates task output from its structured result", async () => {
    const harness = createHost({
      files: { "/workspace/run.js": "" },
      result: { stdout: "done", value: { title: "Example" } },
    });

    const result = await runCommand(harness.host, ["puppeteer", "run.js"], context());

    expect(result.stdout).toBe('done\n{\n  "title": "Example"\n}\n');
  });

  it("does not add a blank line when task output already ends with one", async () => {
    const harness = createHost({
      files: { "/workspace/run.js": "" },
      result: { stdout: "done\n", value: { title: "Example" } },
    });

    const result = await runCommand(harness.host, ["puppeteer", "run.js"], context());

    expect(result.stdout).toBe('done\n{\n  "title": "Example"\n}\n');
  });

  it("selects the backend named by BROWSER_BACKEND", async () => {
    const harness = createHost({ files: { "/workspace/run.js": "" } });

    await runCommand(
      harness.host,
      ["puppeteer", "run.js"],
      context({ env: new Map([["BROWSER_BACKEND", "browser-js"]]) }),
    );

    expect(harness.execCalls[0].options.backend).toBe("browser-js");
  });

  it("kills the task when the shell cancels", async () => {
    const harness = createHost({ files: { "/workspace/run.js": "" } });
    const controller = new AbortController();
    const host: BrowserCommandHost = {
      ...harness.host,
      runtime: {
        ...harness.host.runtime,
        async exec(source, options) {
          const handle = await harness.host.runtime.exec(source, options);
          controller.abort();
          return handle;
        },
      },
    };

    await runCommand(host, ["puppeteer", "run.js"], context({ signal: controller.signal }));

    expect(harness.killed).toEqual(["exec-1"]);
  });

  it("resolves a remote execution id before cancelling it", async () => {
    const harness = createHost({
      files: { "/workspace/run.js": "" },
      neverSettles: true,
      rpcHandleId: true,
    });
    const controller = new AbortController();
    const host: BrowserCommandHost = {
      ...harness.host,
      runtime: {
        ...harness.host.runtime,
        async exec(source, options) {
          const handle = await harness.host.runtime.exec(source, options);
          controller.abort();
          return handle;
        },
      },
    };

    await runCommand(host, ["puppeteer", "run.js"], context({ signal: controller.signal }));

    expect(harness.killed).toEqual(["exec-1"]);
  });

  it("disposes the remote handle when its execution id rejects", async () => {
    const harness = createHost({
      files: { "/workspace/run.js": "" },
      failHandleId: new Error("id unavailable"),
    });

    const result = await runCommand(harness.host, ["puppeteer", "run.js"], context());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("id unavailable");
    expect(harness.disposed).toBe(1);
  });

  // The command waits on a run owned by another backend. Cancellation
  // has to end the command itself, not just ask the other side to stop,
  // because the shell disposes the workspace stub as soon as it returns.
  describe("when the shell cancels", () => {
    it("stops waiting instead of hanging on the nested run", async () => {
      const harness = createHost({ files: { "/workspace/run.js": "" }, neverSettles: true });
      const controller = new AbortController();
      const host: BrowserCommandHost = {
        ...harness.host,
        runtime: {
          ...harness.host.runtime,
          async exec(source, options) {
            const handle = await harness.host.runtime.exec(source, options);
            controller.abort();
            return handle;
          },
        },
      };

      const result = await runCommand(
        host,
        ["puppeteer", "run.js"],
        context({ signal: controller.signal }),
      );

      expect(result.exitCode).toBe(130);
      expect(harness.killed).toEqual(["exec-1"]);
    });

    it("reports a kill that did not take", async () => {
      const harness = createHost({
        files: { "/workspace/run.js": "" },
        neverSettles: true,
        failKill: new Error("backend refused the kill"),
      });
      const controller = new AbortController();
      const host: BrowserCommandHost = {
        ...harness.host,
        runtime: {
          ...harness.host.runtime,
          async exec(source, options) {
            const handle = await harness.host.runtime.exec(source, options);
            controller.abort();
            return handle;
          },
        },
      };

      const result = await runCommand(
        host,
        ["puppeteer", "run.js"],
        context({ signal: controller.signal }),
      );

      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain("backend refused the kill");
    });
  });

  it("removes a temporary module left behind by a failed write", async () => {
    const harness = createHost({
      failWriteAfterCreating: new Error("quota exceeded"),
    });

    const result = await runCommand(
      harness.host,
      ["puppeteer", "--stdin"],
      context({ stdin: "export default () => 1" }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("quota exceeded");
    expect(harness.removed).toHaveLength(1);
    expect(harness.files.size).toBe(0);
  });

  it("prints usage for --help", async () => {
    const harness = createHost();

    const result = await runCommand(harness.host, ["--help"], context());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("browser puppeteer");
    expect(result.stderr).toBe("");
  });

  it("reports a usage error on stderr", async () => {
    const harness = createHost();

    const result = await runCommand(harness.host, ["puppeteer"], context());

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("browser:");
    expect(harness.execCalls).toHaveLength(0);
  });
});
