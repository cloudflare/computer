// Drive the TanStack AI example's agent loop locally, with no
// Cloudflare account.
//
// `chat()`, the agent loop, the tools, and the Workspace are the real
// ones. Only the provider is substituted: a hand-written adapter
// replays scripted assistant turns instead of calling Workers AI, so
// the tool calls are fixed rather than chosen by a model.
//
//   node run-local.mjs

import { Workspace } from "@cloudflare/computer";
import { createTanStackTools } from "@cloudflare/computer/tools/tanstack";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { chat, maxIterations } from "@tanstack/ai";

const workspace = new Workspace({ storage: new SQLiteTestStorage() });
const tools = createTanStackTools({ workspace });

// Scripted turns: write a file, read it back, then answer. Each entry is
// what the "model" emits for that iteration of the agent loop.
const script = [
  {
    toolCalls: [
      {
        name: "write",
        args: {
          path: "/workspace/haiku.txt",
          content: "durable object\nholds a file across restarts\npatient as a stone\n",
        },
      },
    ],
  },
  { toolCalls: [{ name: "read", args: { path: "/workspace/haiku.txt" } }] },
  { text: "Wrote the haiku and read it back." },
];

let turn = 0;

// The smallest adapter shape chat() will drive. It yields AG-UI events
// for one assistant turn, then stops.
const scriptedAdapter = {
  name: "scripted",
  model: "scripted",
  provider: "scripted",
  capabilities: { streaming: true, tools: true },
  async *chatStream() {
    const step = script[Math.min(turn, script.length - 1)];
    turn += 1;
    const messageId = `m${turn}`;
    yield { type: "RUN_STARTED", timestamp: Date.now() };

    if (step.toolCalls) {
      for (const [i, call] of step.toolCalls.entries()) {
        const toolCallId = `call-${turn}-${i}`;
        yield {
          type: "TOOL_CALL_START",
          toolCallId,
          toolCallName: call.name,
          toolName: call.name,
          index: i,
          timestamp: Date.now(),
        };
        yield {
          type: "TOOL_CALL_ARGS",
          toolCallId,
          delta: JSON.stringify(call.args),
          timestamp: Date.now(),
        };
        yield {
          type: "TOOL_CALL_END",
          toolCallId,
          toolCallName: call.name,
          toolName: call.name,
          input: call.args,
          timestamp: Date.now(),
        };
      }
      yield { type: "RUN_FINISHED", finishReason: "tool_calls", timestamp: Date.now() };
      return;
    }

    yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp: Date.now() };
    yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: step.text, timestamp: Date.now() };
    yield { type: "TEXT_MESSAGE_END", messageId, timestamp: Date.now() };
    yield { type: "RUN_FINISHED", finishReason: "stop", timestamp: Date.now() };
  },
};

const stream = chat({
  adapter: scriptedAdapter,
  systemPrompts: ["You are working in a directory at /workspace."],
  messages: [{ role: "user", content: "Write a haiku to /workspace/haiku.txt then read it back." }],
  tools,
  agentLoopStrategy: maxIterations(10),
});

// Watch the tool results go by, then take the final text.
const chunks = [];
for await (const chunk of stream) {
  if (chunk.type === "TOOL_CALL_END") {
    chunks.push(JSON.stringify(chunk).slice(0, 320));
  }
  if (chunk.type === "TEXT_MESSAGE_CONTENT") chunks.push(`text: ${chunk.delta}`);
}
for (const line of chunks) console.log(line);

const onDisk = await workspace.fs.readFile("/workspace/haiku.txt", "utf8");
console.log("\nfile on disk:", JSON.stringify(onDisk));
