#!/usr/bin/env node
// codemode — run a script against the host from inside the container.
//
// The script body travels to the workspace's Durable Object over a
// capnweb WebSocket and runs there in a dynamic worker, with the
// connectors the host was configured with in scope as typed globals.
// The container reaches the host the same way computerd does: an
// HTTP request to the egress hostname the host intercepts. No
// credential is involved; being inside the container is the
// capability.
//
// Usage:
//   codemode < script.js
//   codemode script.js
//   codemode -e 'return await kv.get({ key: "a" })'
//   codemode --types
//
// Exit codes: 0 completed, 1 the script threw, 2 usage or connection
// failure, 3 the run paused for approval on the host.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { CodemodeResult, CodemodeRPC } from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "ws";

const DEFAULT_URL = "ws://computer.internal/codemode";
const DEFAULT_TIMEOUT_MS = 90_000;

const USAGE = `codemode - run a script against this workspace's host

Usage:
  codemode < script.js          run a script from stdin
  codemode script.js            run a script file
  codemode -e 'return 1 + 1'    run inline code
  codemode --types              print the TypeScript declarations of the globals

The script is the body of an async function: use \`return\` to send a
value back. Every connector the host configured is a global; every call
returns a Promise. console.log output comes back on stderr.

Options:
  -e, --eval <code>   inline code
      --types         print declarations and exit
      --json          print the raw result object
      --timeout <ms>  give up after this many milliseconds (default ${DEFAULT_TIMEOUT_MS})
  -h, --help          show this help

Environment:
  CODEMODE_URL        host endpoint (default ${DEFAULT_URL})

Exit codes: 0 completed, 1 script error, 2 usage or connection error,
3 paused for approval.
`;

interface CodemodeIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  stdinIsTTY: boolean;
}

async function main(argv: string[], env: NodeJS.ProcessEnv, io: CodemodeIo): Promise<number> {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    io.stderr(`${describeError(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }

  const url = env.CODEMODE_URL ?? DEFAULT_URL;
  let code: string | undefined;
  if (!parsed.types) {
    try {
      code = await loadCode(parsed, io);
    } catch (error) {
      io.stderr(`${describeError(error)}\n`);
      return 2;
    }
  }

  let ws: WebSocket;
  try {
    ws = await withTimeout(openSocket(url), parsed.timeoutMs, "connect");
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n`);
    return 2;
  }

  const api = newWebSocketRpcSession<CodemodeRPC>(ws as unknown as globalThis.WebSocket);
  try {
    if (parsed.types) {
      const description = await withTimeout(api.describe(), parsed.timeoutMs, "describe");
      io.stdout(`${description.types.trim()}\n`);
      return 0;
    }
    const outcome = await withTimeout<CodemodeResult>(
      api.execute({ code: code ?? "" }),
      parsed.timeoutMs,
      "execute",
    );
    return report(outcome, parsed.json, io);
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n`);
    return 2;
  } finally {
    // Disposing the root stub ends the session; capnweb closes the
    // socket behind it.
    api[Symbol.dispose]();
  }
}

interface Parsed {
  help: boolean;
  types: boolean;
  json: boolean;
  timeoutMs: number;
  eval: string | undefined;
  file: string | undefined;
}

function parseArguments(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      eval: { type: "string", short: "e" },
      types: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const timeoutMs = Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got ${values.timeout}`);
  }
  if (positionals.length > 1) {
    throw new Error(`expected at most one script path, got ${positionals.length}`);
  }
  return {
    help: values.help,
    types: values.types,
    json: values.json,
    timeoutMs,
    eval: values.eval,
    file: positionals[0],
  };
}

async function loadCode(parsed: Parsed, io: CodemodeIo): Promise<string> {
  const code = await readSource(parsed, io);
  if (code.trim() === "") {
    throw new Error("no script given: pipe one on stdin, pass a file path, or use -e");
  }
  return code;
}

async function readSource(parsed: Parsed, io: CodemodeIo): Promise<string> {
  if (parsed.eval !== undefined) return parsed.eval;
  if (parsed.file !== undefined) return readFile(parsed.file, "utf8");
  if (io.stdinIsTTY) return "";
  return io.stdin();
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_request, response) => {
      reject(new Error(`${url} answered HTTP ${response.statusCode} instead of upgrading`));
    });
    ws.once("error", (error) => reject(new Error(`could not connect to ${url}: ${error.message}`)));
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function exitCode(outcome: CodemodeResult): number {
  switch (outcome.status) {
    case "completed":
      return 0;
    case "error":
      return 1;
    case "paused":
      return 3;
  }
}

function report(outcome: CodemodeResult, json: boolean, io: CodemodeIo): number {
  if (json) {
    io.stdout(`${JSON.stringify(outcome, null, 2)}\n`);
    return exitCode(outcome);
  }
  if (outcome.status !== "paused") {
    for (const line of outcome.logs ?? []) io.stderr(`${line}\n`);
  }
  switch (outcome.status) {
    case "error":
      io.stderr(`error: ${outcome.error}\n`);
      break;
    case "paused":
      io.stderr(`paused: execution ${outcome.executionId} is waiting for approval on the host\n`);
      break;
    case "completed":
      if (outcome.result !== undefined) {
        const text =
          typeof outcome.result === "string"
            ? outcome.result
            : JSON.stringify(outcome.result, null, 2);
        io.stdout(`${text}\n`);
      }
  }
  return exitCode(outcome);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIo(): CodemodeIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: process.stdin.isTTY === true,
    stdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

// Started unconditionally, as computerd is: inside the SEA the bundle is
// imported from a data: URL, so there is no `require.main` to compare.
main(process.argv.slice(2), process.env, processIo())
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`codemode: ${describeError(error)}\n`);
    process.exit(2);
  });
