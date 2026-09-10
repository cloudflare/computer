// The codemode CLI is a thin capnweb client: connect, call one method,
// print, exit with a meaningful code. These tests spawn the built CLI
// against a local WebSocket server that serves a fake CodemodeRPC, so
// the only real piece missing is the host itself.

import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodemodeDescription,
  CodemodePendingAction,
  CodemodeResult,
  CodemodeRPC,
  CodemodeSearch,
} from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const cliPath = path.join(packageRoot, "dist", "cli", "codemode.cjs");

const TYPES = "declare const kv: {\n\tget: (input: GetInput) => Promise<GetOutput>;\n}";
const PENDING: CodemodePendingAction = {
  executionId: "x2",
  seq: 1,
  connector: "kv",
  method: "put",
  args: { key: "a" },
};

class FakeCodemode extends RpcTarget implements CodemodeRPC {
  static calls: unknown[] = [];

  async types() {
    return { types: TYPES, connectors: ["kv"] };
  }

  async search(query: string): Promise<CodemodeSearch> {
    FakeCodemode.calls.push(["search", query]);
    return {
      results: [
        {
          path: "kv.get",
          connector: "kv",
          method: "get",
          description: "Read a key.",
          kind: "method",
          score: 1,
        },
        {
          path: "kv.put",
          connector: "kv",
          method: "put",
          requiresApproval: true,
          kind: "method",
          score: 0.5,
        },
      ],
      total: 2,
      truncated: false,
    };
  }

  async describe(target: string): Promise<CodemodeDescription> {
    FakeCodemode.calls.push(["describe", target]);
    return { path: target, types: `declare const ${target}: {}`, kind: "connector" };
  }

  async execute({ code }: { code: string }): Promise<CodemodeResult> {
    FakeCodemode.calls.push(["execute", code]);
    if (code.includes("throw")) {
      return { status: "error", executionId: "x1", error: "nope", logs: ["before"] };
    }
    if (code.includes("pause")) return { status: "paused", executionId: "x2", pending: [PENDING] };
    return { status: "completed", executionId: "x3", result: { echoed: code }, logs: ["log line"] };
  }

  async pending(executionId?: string) {
    FakeCodemode.calls.push(["pending", executionId]);
    return [PENDING];
  }
}

let server: WebSocketServer;
let url: string;

beforeAll(async () => {
  server = new WebSocketServer({ port: 0, path: "/codemode" });
  server.on("connection", (socket: WebSocket) => {
    newWebSocketRpcSession(socket as unknown as globalThis.WebSocket, new FakeCodemode());
  });
  await once(server, "listening");
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/codemode`;
});

afterAll(() => {
  server.close();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: packageRoot,
      env: { ...process.env, CODEMODE_URL: url, ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

test("types prints the host's declarations", async () => {
  const result = await run(["types"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${TYPES}\n`);
});

test("a script on stdin runs on the host; logs go to stderr and the result to stdout", async () => {
  const result = await run([], "return 1");
  expect(result.code).toBe(0);
  expect(FakeCodemode.calls.at(-1)).toEqual(["execute", "return 1"]);
  expect(result.stderr).toBe("log line\n");
  expect(JSON.parse(result.stdout)).toEqual({ echoed: "return 1" });
});

test("-e runs inline code and --json prints the raw result", async () => {
  const result = await run(["-e", "return 2", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    status: "completed",
    executionId: "x3",
    result: { echoed: "return 2" },
    logs: ["log line"],
  });
});

test("a script error exits 1", async () => {
  const result = await run(["run", "-e", "throw new Error()"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("before\nerror: nope\n");
});

test("a paused run exits 3 and names what it is waiting on", async () => {
  const result = await run(["-e", "pause"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toBe(
    'paused: execution x2 is waiting for approval on seq 1: kv.put({"key":"a"})\n',
  );
  expect(result.stdout).toBe("");
});

test("search lists matches one per line and flags approval", async () => {
  const result = await run(["search", "read a", "key"]);
  expect(result.code).toBe(0);
  expect(FakeCodemode.calls.at(-1)).toEqual(["search", "read a key"]);
  expect(result.stdout).toBe("kv.get  Read a key.\nkv.put (requires approval)\n");
});

test("describe prints one target's declarations", async () => {
  const result = await run(["describe", "kv"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("declare const kv: {}\n");
});

test("pending lists waiting actions", async () => {
  const result = await run(["pending", "x2"]);
  expect(result.code).toBe(0);
  expect(FakeCodemode.calls.at(-1)).toEqual(["pending", "x2"]);
  expect(result.stdout).toBe('x2 seq 1: kv.put({"key":"a"})\n');
});

test("usage mistakes exit 2 before any connection", async () => {
  const noScript = await run([]);
  expect(noScript.code).toBe(2);
  expect(noScript.stderr).toMatch(/no script given/);
  const badDescribe = await run(["describe"]);
  expect(badDescribe.code).toBe(2);
  expect(badDescribe.stderr).toMatch(/usage: codemode describe/);
  const unknown = await run(["approve", "x2"]);
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toMatch(/run takes at most one script path/);
});

test("an unreachable host is a connection error, not a hang", async () => {
  const result = await run(["types", "--timeout", "2000"], undefined, {
    CODEMODE_URL: "ws://127.0.0.1:1/codemode",
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/could not connect/);
});

test("--help documents every command", async () => {
  const result = await run(["--help"]);
  expect(result.code).toBe(0);
  for (const command of ["types", "search", "describe", "pending"]) {
    expect(result.stdout).toContain(`codemode ${command}`);
  }
});
