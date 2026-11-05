import { describe, expect, it } from "vitest";
import { startProcess, type ExecTarget, type ExecTargetProcess } from "./target";

describe("startProcess", () => {
  it("resolves a plain process", async () => {
    const out = new Blob(["hi"]).stream();
    const killed: (number | undefined)[] = [];
    const target: ExecTarget = {
      exec: async () => ({
        pid: 7,
        stdin: null,
        stdout: out,
        stderr: undefined,
        exitCode: Promise.resolve(3),
        kill: (s) => killed.push(s),
      }),
    };
    const p = await startProcess(target, ["x"]);
    expect(p.pid).toBe(7);
    expect(p.stdin).toBeUndefined();
    expect(p.stderr).toBeUndefined();
    expect(await new Response(p.stdout).text()).toBe("hi");
    expect(await p.exitCode).toBe(3);
    p.kill(9);
    expect(killed).toEqual([9]);
  });

  it("awaits every field of an RPC-stub-like process, where properties are promises", async () => {
    const out = new Blob(["stub"]).stream();
    let exitRead = false;
    const stub = {
      pid: Promise.resolve(42),
      stdin: Promise.resolve(null),
      stdout: Promise.resolve(out),
      stderr: Promise.resolve(null),
      get exitCode() {
        exitRead = true;
        return new Promise<number>((r) => setTimeout(() => r(0), 20));
      },
      kill: async () => Promise.reject(new Error("the process already exited")),
    } as unknown as ExecTargetProcess;
    const p = await startProcess({ exec: async () => stub }, ["x"], { stdout: "pipe" });
    expect(p.pid).toBe(42);
    expect(p.stdin).toBeUndefined();
    expect(await new Response(p.stdout).text()).toBe("stub");
    expect(exitRead).toBe(true);
    expect(await p.exitCode).toBe(0);
    // A kill that rejects (the process is gone) doesn't surface as an unhandled rejection.
    expect(() => p.kill()).not.toThrow();
  });

  it("prefers streams(), so an RPC target's streams are serialized once", async () => {
    let getterReads = 0;
    const p = {
      pid: 3,
      get stdin() {
        getterReads++;
        return undefined;
      },
      get stdout() {
        getterReads++;
        return undefined;
      },
      get stderr() {
        getterReads++;
        return undefined;
      },
      exitCode: Promise.resolve(0),
      kill: () => undefined,
      streams: () => ({ stdin: null, stdout: new Blob(["via streams()"]).stream(), stderr: null }),
    };
    const resolved = await startProcess({ exec: async () => p }, ["x"]);
    expect(await new Response(resolved.stdout).text()).toBe("via streams()");
    expect(getterReads).toBe(0);
  });

  it("passes the command and options through", async () => {
    const seen: unknown[] = [];
    const target: ExecTarget = {
      exec: async (cmd, options) => {
        seen.push(cmd, options);
        return {
          pid: 1,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          exitCode: Promise.resolve(0),
          kill: () => undefined,
        };
      },
    };
    await startProcess(target, ["a", "b"], { stdin: "pipe", stderr: "combined" });
    expect(seen).toEqual([["a", "b"], { stdin: "pipe", stderr: "combined" }]);
  });

  it("propagates a failure to start", async () => {
    await expect(
      startProcess({ exec: async () => Promise.reject(new Error("container not running")) }, ["x"]),
    ).rejects.toThrow("container not running");
  });
});
