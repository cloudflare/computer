// The codemode CLI is a thin capnweb client: connect, call describe or
// execute, print, exit with a meaningful code. These tests spawn the
// built CLI against a local WebSocket server that serves a fake
// CodemodeRPC, so the only real piece missing is the host itself.

import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodemodeResult, CodemodeRPC } from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const cliPath = path.join(packageRoot, "dist", "cli", "codemode.cjs");

const TYPES = "declare const kv: {\n\tget: (input: GetInput) => Promise<GetOutput>;\n}";

class FakeCodemode extends RpcTarget implements CodemodeRPC {
  static executed: string[] = [];

  async describe() {
    return { types: TYPES, connectors: ["kv"] };
  }

  async execute({ code }: { code: string }): Promise<CodemodeResult> {
    FakeCodemode.executed.push(code);
    if (code.includes("throw")) {
      return { status: "error", executionId: "x1", error: "nope", logs: ["before"] };
    }
    if (code.includes("pause")) {
      return { status: "paused", executionId: "x2", pending: [{ seq: 1 }] };
    }
    return { status: "completed", executionId: "x3", result: { echoed: code }, logs: ["log line"] };
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

test("--types prints the host's declarations", async () => {
  const result = await run(["--types"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${TYPES}\n`);
});

test("a script on stdin runs on the host; logs go to stderr and the result to stdout", async () => {
  const result = await run([], "return 1");
  expect(result.code).toBe(0);
  expect(FakeCodemode.executed.at(-1)).toBe("return 1");
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
  const result = await run(["-e", "throw new Error()"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toBe("before\nerror: nope\n");
});

test("a paused run exits 3", async () => {
  const result = await run(["-e", "pause"]);
  expect(result.code).toBe(3);
  expect(result.stderr).toMatch(/paused: execution x2/);
  expect(result.stdout).toBe("");
});

test("no script and no stdin is a usage error", async () => {
  const result = await run([]);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/no script given/);
});

test("an unreachable host is a connection error, not a hang", async () => {
  const result = await run(["--types", "--timeout", "2000"], undefined, {
    CODEMODE_URL: "ws://127.0.0.1:1/codemode",
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/could not connect/);
});

test("--help documents the exit codes", async () => {
  const result = await run(["--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toMatch(/Exit codes: 0 completed, 1 script error/);
});
