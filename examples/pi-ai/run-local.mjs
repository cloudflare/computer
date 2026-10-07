// Drive the pi example's agent loop locally, with no Cloudflare
// account. The loop, tools, and Workspace are real; only the model and
// the storage are substituted, so the tool calls below are scripted
// rather than chosen.
//
//   npm run local

import { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
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
// No backend runs under plain node, so there is no `exec` tool here.
// The unit tests cover exec's argument handling.
const { tools, execute } = createPiTools({ workspace });

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

// One scripted reply per turn: write a file, read it back, then answer.
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

// A failure must come back as a retryable error result, not a throw.
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

await workspace.close?.();
