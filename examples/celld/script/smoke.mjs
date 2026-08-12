#!/usr/bin/env node

// Send one chat message through the Agents WebSocket transport and require a reply.

import assert from "node:assert/strict";
import process from "node:process";

import { WebSocketChatTransport } from "agents/chat/react";
import { AgentClient } from "agents/client";

const host = (process.env.CELLD_WORKER ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const name = process.env.CELLD_AGENT_NAME ?? "smoke";
const expected = process.env.CELLD_EXPECT ?? "celld smoke reply";
const prompt = process.env.CELLD_PROMPT ?? "Reply with the smoke-test phrase.";
const timeoutMs = Number(process.env.CELLD_SMOKE_TIMEOUT_MS ?? "15000");

const client = new AgentClient({ agent: "CelldAgent", name, host });
const transport = new WebSocketChatTransport({ agent: client });

try {
  await withTimeout(client.ready, timeoutMs, "agent connection");

  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: crypto.randomUUID(),
    messageId: undefined,
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
    ],
    abortSignal: AbortSignal.timeout(timeoutMs),
  });

  let reply = "";
  for await (const chunk of stream) {
    if (chunk.type === "text-delta") reply += chunk.delta;
    if (chunk.type === "error") throw new Error(chunk.errorText);
  }

  assert.ok(
    reply.toLowerCase().includes(expected.toLowerCase()),
    `expected reply to contain ${JSON.stringify(expected)}; got ${JSON.stringify(reply)}`,
  );
  console.log(reply);
} finally {
  client.close();
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
