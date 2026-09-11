#!/usr/bin/env node
// codemode — run scripts against the host from inside the container.
//
// The script body travels to the workspace's Durable Object over a
// capnweb WebSocket and runs there in a dynamic worker, with the
// connectors the host was configured with in scope as typed globals.
// The container reaches the host the same way computerd does: an
// HTTP request to the egress hostname the host intercepts. No
// credential is involved; being inside the container is the
// capability.
//
// Exit codes: 0 done, 1 the script threw, 2 usage or connection
// failure, 3 the run paused for approval on the host. Approving is
// not something the container can do, by design: a run pauses because
// a connector asked for a human's decision.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { CodemodeResult, CodemodeRPC } from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession } from "capnweb";
import { WebSocket } from "ws";

const DEFAULT_URL = "ws://computer.internal/codemode";
const DEFAULT_TIMEOUT_MS = 90_000;

const USAGE = `codemode - run scripts against this workspace's host

Usage:
  codemode < script.js                 run a script from stdin
  codemode run script.js               run a script file
  codemode -e 'return 1 + 1'           run inline code
  codemode types                       TypeScript declarations of every global
  codemode search <query>              find connector methods and snippets
  codemode describe <target>           declarations for one connector, method, or snippet
  codemode pending [executionId]       actions a paused run is waiting on

The script is the body of an async function: use \`return\` to send a
value back. Every connector the host configured is a global; every call
returns a Promise. console.log output comes back on stderr.

Options:
  -e, --eval <code>   inline code (run)
      --json          print raw JSON for any command
      --timeout <ms>  give up after this many milliseconds (default ${DEFAULT_TIMEOUT_MS})
  -h, --help          show this help

Environment:
  CODEMODE_URL        host endpoint (default ${DEFAULT_URL})

Exit codes: 0 done, 1 script error, 2 usage or connection error,
3 paused for approval.
`;

const COMMANDS = ["run", "types", "search", "describe", "pending"] as const;
type Command = (typeof COMMANDS)[number];

interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin: () => Promise<string>;
  stdinIsTTY: boolean;
}

interface Parsed {
  command: Command;
  args: string[];
  eval: string | undefined;
  json: boolean;
  timeoutMs: number;
  help: boolean;
}

async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }

  let request: (api: CodemodeRPC) => Promise<number>;
  try {
    request = await prepare(parsed, io);
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n`);
    return 2;
  }

  const url = env.CODEMODE_URL ?? DEFAULT_URL;
  let ws: WebSocket;
  try {
    ws = await withTimeout(openSocket(url), parsed.timeoutMs, "connect");
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n`);
    return 2;
  }

  const api = newWebSocketRpcSession<CodemodeRPC>(ws as unknown as globalThis.WebSocket);
  try {
    return await withTimeout(request(api), parsed.timeoutMs, parsed.command);
  } catch (error) {
    io.stderr(`codemode: ${describeError(error)}\n`);
    return 2;
  } finally {
    // Disposing the root stub ends the session; capnweb closes the
    // socket behind it.
    api[Symbol.dispose]();
  }
}

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      eval: { type: "string", short: "e" },
      json: { type: "boolean", default: false },
      timeout: { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const timeoutMs = Number(values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got ${values.timeout}`);
  }
  const [first, ...rest] = positionals;
  const named = COMMANDS.find((c) => c === first);
  // A bare path or nothing at all means run: `codemode script.js`,
  // `codemode < script.js`, `codemode -e '...'`.
  const command: Command = named ?? "run";
  const args = named === undefined ? positionals : rest;
  return { command, args, eval: values.eval, json: values.json, timeoutMs, help: values.help };
}

// Validates arguments and reads any input before connecting, so a
// usage mistake never opens a socket.
async function prepare(parsed: Parsed, io: Io): Promise<(api: CodemodeRPC) => Promise<number>> {
  const { args, json } = parsed;
  const print = (value: unknown) => io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  switch (parsed.command) {
    case "run": {
      const code = await loadCode(parsed, io);
      return async (api) => report(await api.execute({ code }), json, io);
    }
    case "types": {
      expectArgs(args, 0, "types");
      return async (api) => {
        const description = await api.types();
        if (json) print(description);
        else io.stdout(`${description.types.trim()}\n`);
        return 0;
      };
    }
    case "search": {
      const query = args.join(" ").trim();
      if (query === "") throw new Error("search needs a query");
      return async (api) => {
        const found = await api.search(query);
        if (json) {
          print(found);
          return 0;
        }
        for (const hit of found.results) {
          const flag = hit.requiresApproval ? " (requires approval)" : "";
          io.stdout(`${hit.path}${flag}${hit.description ? `  ${hit.description}` : ""}\n`);
        }
        if (found.truncated) io.stderr(`${found.total} matches, showing ${found.results.length}\n`);
        return 0;
      };
    }
    case "describe": {
      expectArgs(args, 1, "describe <target>");
      const target = args[0] ?? "";
      return async (api) => {
        const described = await api.describe(target);
        if (json) print(described);
        else io.stdout(`${described.types.trim()}\n`);
        return 0;
      };
    }
    case "pending": {
      if (args.length > 1) throw new Error("pending takes at most one execution id");
      return async (api) => {
        const actions = await api.pending(args[0]);
        if (json) {
          print(actions);
          return 0;
        }
        for (const action of actions) {
          io.stdout(
            `${action.executionId} seq ${action.seq}: ${action.connector}.${action.method}(${JSON.stringify(action.args)})\n`,
          );
        }
        return 0;
      };
    }
  }
}

function expectArgs(args: string[], count: number, usage: string): void {
  if (args.length !== count) throw new Error(`usage: codemode ${usage}`);
}

async function loadCode(parsed: Parsed, io: Io): Promise<string> {
  if (parsed.args.length > 1) throw new Error("run takes at most one script path");
  const code = await readSource(parsed, io);
  if (code.trim() === "") {
    throw new Error("no script given: pipe one on stdin, pass a file path, or use -e");
  }
  return code;
}

async function readSource(parsed: Parsed, io: Io): Promise<string> {
  if (parsed.eval !== undefined) return parsed.eval;
  const file = parsed.args[0];
  if (file !== undefined) return readFile(file, "utf8");
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

function report(outcome: CodemodeResult, json: boolean, io: Io): number {
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
    case "paused": {
      const waiting = outcome.pending
        .map((a) => `seq ${a.seq}: ${a.connector}.${a.method}(${JSON.stringify(a.args)})`)
        .join("; ");
      io.stderr(
        `paused: execution ${outcome.executionId} is waiting for approval${waiting ? ` on ${waiting}` : ""}\n`,
      );
      break;
    }
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

function processIo(): Io {
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
// The exit code is set rather than forced so a large result piped to
// another process drains before the process ends.
main(process.argv.slice(2), process.env, processIo())
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`codemode: ${describeError(error)}\n`);
    process.exitCode = 2;
  });
