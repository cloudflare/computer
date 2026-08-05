#!/usr/bin/env node

/**
 * chat [--worker URL] [--name NAME] [--title TITLE]
 *
 * A terminal chat window onto the agent, and the place you can watch
 * an approval actually happen. Ask it to read something and it just
 * answers; ask it to change something and the turn stops and waits for
 * you.
 *
 * There is deliberately very little here. The AI SDK's terminal UI
 * already knows how to render a pending approval and send the answer
 * back, and the worker speaks the UI message stream that
 * `DefaultChatTransport` posts to, so the client is a URL and one
 * wrapper.
 *
 * The conversation lives in this process rather than on the server,
 * which is why the worker signs its approval requests: an approval
 * comes back as a claim this client makes about something you
 * supposedly did, and the signature is what makes that claim checkable
 * rather than merely plausible. The wrapper is there because the
 * terminal UI throws that signature away when it records your answer;
 * ./approval-signatures.mjs explains what it does about it.
 *
 * The worker has to be running first (`npm run dev`, default
 * http://127.0.0.1:8787). Point somewhere else with --worker or the
 * AGENT_WORKER env var.
 *
 * Two things worth trying, in this order:
 *
 *   cat the file at /workspace/hello.txt
 *       Runs unattended. The matcher recognizes it, so it never asks —
 *       and it ran without write access, which cost it nothing.
 *
 *   delete everything under /workspace
 *       Stops and asks. Say no and nothing happens. Say yes and it
 *       runs with the write access that approval bought it. Either way,
 *       `curl localhost:8787/c/<name>/audit` shows what the workspace
 *       recorded, including the answer you gave.
 */

import { argv, env, exit, stderr } from "node:process";
import { runAgentTUI } from "@ai-sdk/tui";
import { DefaultChatTransport } from "ai";
import { withApprovalSignatures } from "./approval-signatures.mjs";

const { workerUrl, name, title } = parseArgs(argv.slice(2));

let base;
try {
  base = new URL(workerUrl);
} catch {
  stderr.write(`invalid --worker URL: ${workerUrl}\n`);
  exit(2);
}

const api = new URL(`/c/${encodeURIComponent(name)}/agent`, base).toString();

stderr.write(`talking to ${api}\n`);

await runAgentTUI({
  // The wrapper is not decoration: the terminal UI drops the signature
  // off an approval when it records your answer, and the worker will
  // not run an unsigned one. See ./approval-signatures.mjs.
  transport: withApprovalSignatures(new DefaultChatTransport({ api })),
  title: title ?? `computer-agent · ${name}`,
});

function parseArgs(args) {
  let workerUrl = env.AGENT_WORKER ?? "http://127.0.0.1:8787";
  let name = env.AGENT_WORKSPACE ?? "default";
  let title;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--worker") {
      workerUrl = args[++i] ?? workerUrl;
    } else if (a === "--name") {
      name = args[++i] ?? name;
    } else if (a === "--title") {
      title = args[++i] ?? title;
    } else if (a === "-h" || a === "--help") {
      stderr.write("usage: chat [--worker URL] [--name NAME] [--title TITLE]\n");
      exit(0);
    }
  }
  return { workerUrl: workerUrl.replace(/\/+$/, ""), name, title };
}
