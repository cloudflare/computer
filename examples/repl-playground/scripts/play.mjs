#!/usr/bin/env node
// Tiny CLI for the repl-playground worker.
//
//   node scripts/play.mjs eval 'code...' [--session NAME] [--ws NAME] [--full]
//   node scripts/play.mjs eval -            (read code from stdin)
//   node scripts/play.mjs tool|sessions|counts|outbox|restart|reset [--ws NAME]
//   node scripts/play.mjs history [--session NAME] [--effects] [--ws NAME]
//
// Configuration (env vars, or files in the example root):
//   PLAYGROUND_URL       base URL (default http://localhost:8787 for `wrangler dev`)
//   PLAYGROUND_TOKEN     bearer token, or a .playground-token file
//   CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
//                        optional Access service token, or a .access-creds file

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.PLAYGROUND_URL ?? "http://localhost:8787").replace(/\/$/, "");

const readOptional = (name) =>
  existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8").trim() : undefined;
const token = process.env.PLAYGROUND_TOKEN ?? readOptional(".playground-token");
const creds = {
  ...Object.fromEntries(
    (readOptional(".access-creds") ?? "")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  ),
  ...(process.env.CF_ACCESS_CLIENT_ID ? { CF_ACCESS_CLIENT_ID: process.env.CF_ACCESS_CLIENT_ID } : {}),
  ...(process.env.CF_ACCESS_CLIENT_SECRET ? { CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET } : {}),
};
if (token === undefined) {
  console.error("Set PLAYGROUND_TOKEN (or create .playground-token) to match the worker's token.");
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token}`,
  ...(creds.CF_ACCESS_CLIENT_ID
    ? { "CF-Access-Client-Id": creds.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": creds.CF_ACCESS_CLIENT_SECRET }
    : {}),
  "content-type": "application/json",
};

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const has = (name) => args.includes(`--${name}`);
const ws = flag("ws") ?? "default";

async function call(path, init) {
  const res = await fetch(`${BASE}${path}`, { headers, ...init });
  const body = await res.json();
  if (!res.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

if (command === "eval") {
  let code = args[1];
  if (code === "-" || code === undefined) code = readFileSync(0, "utf8");
  const sessionName = flag("session");
  const out = await call("/eval", {
    method: "POST",
    body: JSON.stringify({ ws, code, ...(sessionName === undefined ? {} : { sessionName }) }),
  });
  if (has("full")) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(
      `[${out.ok ? "ok" : "ERR"}] cell ${out.executionCount} · ${out.ms}ms · session ${out.session}`,
    );
    console.log(out.rendered);
  }
} else if (command === "tool") {
  const out = await call(`/tool?ws=${ws}`);
  console.log(out.description);
  console.log("\nschema:", JSON.stringify(out.inputSchema));
} else if (command === "history") {
  const session = flag("session") ?? "main";
  const effects = has("effects") ? "&effects=1" : "";
  console.log(JSON.stringify(await call(`/history?ws=${ws}&session=${session}${effects}`), null, 2));
} else if (["sessions", "counts", "outbox"].includes(command)) {
  console.log(JSON.stringify(await call(`/${command}?ws=${ws}`), null, 2));
} else if (command === "restart" || command === "reset") {
  console.log(JSON.stringify(await call(`/${command}`, { method: "POST", body: JSON.stringify({ ws }) })));
} else {
  console.error("usage: play.mjs eval|tool|sessions|history|counts|outbox|restart|reset ...");
  process.exit(1);
}
