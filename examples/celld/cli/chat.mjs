#!/usr/bin/env node

// Open an AI SDK terminal chat connected to the CelldAgent Durable Object.

import { argv, env, exit, stderr } from "node:process";

import { runAgentTUI } from "@ai-sdk/tui";
import { WebSocketChatTransport } from "agents/chat/react";
import { AgentClient } from "agents/client";

const { workerUrl, name, title } = parseArgs(argv.slice(2));

let base;
try {
  base = new URL(workerUrl);
} catch {
  stderr.write(`invalid --worker URL: ${workerUrl}\n`);
  exit(2);
}

const secure = base.protocol === "https:" || base.protocol === "wss:";
const host = `${secure ? "https" : "http"}://${base.host}`;
const client = new AgentClient({ agent: "CelldAgent", name, host });
const transport = new WebSocketChatTransport({ agent: client });

stderr.write(`connecting to ${host} (agent "celld-agent", instance "${name}")\n`);

await runAgentTUI({
  transport,
  title: title ?? `celld · ${name}`,
});

function parseArgs(args) {
  let workerUrl = env.CELLD_WORKER ?? "http://127.0.0.1:8080";
  let name = env.CELLD_AGENT_NAME ?? "default";
  let title;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--worker") {
      workerUrl = args[++i] ?? workerUrl;
    } else if (arg === "--name") {
      name = args[++i] ?? name;
    } else if (arg === "--title") {
      title = args[++i] ?? title;
    } else if (arg === "-h" || arg === "--help") {
      stderr.write("usage: chat [--worker URL] [--name NAME] [--title TITLE]\n");
      exit(0);
    }
  }
  return { workerUrl: workerUrl.replace(/\/+$/, ""), name, title };
}
