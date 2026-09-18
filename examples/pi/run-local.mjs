// Drive the pi example's agent loop locally, with no Cloudflare account.
//
// The loop, the tool declarations, and the dispatcher are the real ones
// from @cloudflare/computer/tools/pi against a real Workspace. Only two
// things are substituted: pi's own fauxProvider stands in for Workers
// AI, so the tool calls are scripted rather than chosen by a model, and
// an in-memory SQLite storage stands in for Durable Object storage.
//
//   node run-local.mjs

import { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

const MAX_TURNS = 10;

const workspace = new Workspace({ storage: new SQLiteTestStorage() });
// `exec` needs a backend to be declared. There is no shell backend in
// plain node, so calling it fails at the backend — which is after the
// argument handling this script is checking.
const { tools, execute } = createPiTools({
  workspace,
  shell: { defaultBackend: "shell", backends: { shell: { description: "test shell" } } },
});

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

// What the model "decides" to do, one reply per turn: write a file,
// read it back, then answer.
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall("write", {
        path: "/workspace/haiku.txt",
        content: "durable object\nholds a file across restarts\npatient as a stone\n",
      }),
    ],
    { stopReason: "toolUse" },
  ),
]);

const messages = [
  {
    role: "user",
    content: "Write a haiku to /workspace/haiku.txt then read it back.",
    timestamp: Date.now(),
  },
];

let answer = "(no answer)";
for (let turn = 0; turn < MAX_TURNS; turn += 1) {
  const reply = await models.complete(model, {
    systemPrompt: "You are working in a directory at /workspace.",
    messages,
    tools,
  });
  messages.push(reply);

  const calls = reply.content.filter((block) => block.type === "toolCall");
  if (calls.length === 0) {
    answer = reply.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    break;
  }

  for (const call of calls) {
    const { content, isError } = await execute(call);
    console.log(
      `turn ${turn}: ${call.name}(${JSON.stringify(call.arguments).slice(0, 60)}) -> isError=${isError} ${JSON.stringify(content).slice(0, 110)}`,
    );
    messages.push({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError,
      timestamp: Date.now(),
    });
  }

  // Script the next reply, now that this turn's tools have run.
  if (turn === 0) {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "/workspace/haiku.txt" })], {
        stopReason: "toolUse",
      }),
    ]);
  } else if (turn === 1) {
    faux.setResponses([fauxAssistantMessage([fauxText("Wrote the haiku and read it back.")])]);
  }
}

console.log("\nanswer:", answer);

// Prove the tools really touched the workspace, not a mock of it.
const onDisk = await workspace.fs.readFile("/workspace/haiku.txt", "utf8");
console.log("file on disk:", JSON.stringify(onDisk));

// And that a failure comes back as a retryable error result.
const missing = await execute({
  id: "x",
  name: "read",
  arguments: { path: "/workspace/nope.txt" },
});
console.log(
  "missing file  -> isError=%s %s",
  missing.isError,
  JSON.stringify(missing.content).slice(0, 80),
);

// The review's item 3: a deliberate null input to a callable backend.
const nulled = await execute({
  id: "y",
  name: "exec",
  arguments: { command: "echo hi", input: null },
});
console.log(
  "exec input:null -> isError=%s %s",
  nulled.isError,
  JSON.stringify(nulled.content).slice(0, 110),
);

await workspace.close?.();
