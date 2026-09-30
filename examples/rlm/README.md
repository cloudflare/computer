# Build an RLM with Cloudflare Computer

This example shows how to build a recursive language model (RLM) with [`@cloudflare/computer`](../../packages/computer).

The main idea is:

> Use models for meaning. Use code for totals.

A long corpus lives in a Computer Workspace instead of the parent model's prompt. The model writes a JavaScript module that reads the corpus, sends bounded partitions to model workers, validates their structured answers, and combines them with normal code.

```text
long context in a Workspace
        ↓
generated JavaScript
        ↓
bounded model calls over partitions
        ↓
JavaScript validation and reduction
        ↓
answer
```

The browser runs the same long-context task three ways so you can see what the RLM adds:

| Strategy | What it can use |
|---|---|
| Direct context | One model call with the complete corpus in its prompt |
| JavaScript only | A Workspace and generated JavaScript |
| Structured RLM | A Workspace, generated JavaScript, and bounded model calls through `ws:model` |

## Why use this pattern?

RLMs are useful when a task needs broad semantic coverage across more data than you want to place in one prompt. Examples include:

- Classifying every record in a large collection, then counting the labels.
- Extracting events or entities from many documents, then sorting or grouping them.
- Comparing evidence across many files instead of retrieving only the top few matches.
- Keeping a large working set in durable storage while returning a small answer to the parent model.

The model workers handle questions such as “is this sentence formal?” or “was this spell upcast?” JavaScript handles operations such as counting, validation, ordering, deduplication, and tie-breaking.

This pattern is less useful when the context already fits comfortably in one prompt, retrieval can find a small relevant subset, or ordinary code can solve the whole task without semantic interpretation.

## How the example works

1. The host fetches an official Oolong task and writes its corpus and manifest to a Workspace.
2. The parent model receives the question, file paths, and the available Computer tool. It does not receive the complete corpus.
3. The parent writes a complete ECMAScript module for the Worker JavaScript backend.
4. That module reads record-aligned partitions from the Workspace.
5. The module calls `ws:model` with a bounded batch of classification or extraction requests.
6. The module validates the returned JSON and reduces it to one answer with JavaScript.
7. The UI shows the generated module, map calls, token use, duration, and official Oolong score.

The default task classifies 2,433 sentences as formal or informal. The RLM maps 22 partitions through model workers and then adds the returned label counts exactly.

## The Computer pieces

The host gives generated code a read-only Workspace and one trusted model module:

```ts
const modelCapability = createModelCapability(model, hooks);

const backend = new WorkerJavaScriptBackend({
  id: "oolong-rlm-javascript",
  loader: env.LOADER,
  root: "/workspace",
  access: "read",
  egress: { mode: "none" },
  modules: {
    "ws:model": modelCapability,
  },
});

const workspace = new Workspace({
  storage: ctx.storage,
  backends: [backend],
});
```

The important line is `modules`. Generated code cannot read model credentials or call the network directly. It can only use the host-owned `ws:model` interface.

A generated module follows this shape:

```js
import fs from "node:fs/promises";
import { batch } from "ws:model";

export default async function () {
  const manifest = JSON.parse(
    await fs.readFile("/workspace/oolong-real/manifest.json", "utf8"),
  );
  const requests = await Promise.all(
    manifest.contextChunks.map(async (chunk) => ({
      prompt: "Classify every record and return JSON label counts.",
      input: await fs.readFile(chunk.path, "utf8"),
    })),
  );

  const mapped = await batch(requests);
  const totals = validateAndSum(mapped);
  return { answer: largestLabel(totals) };
}
```

The real module is written by the parent model at runtime. Open **Generated map/reduce module** in the RLM lane to inspect it.

## Run it locally

Workers AI is remote during local development. A complete comparison can take several minutes, use more than 200,000 model tokens, and incur usage charges.

From the repository root:

```sh
npm install
npm run build --workspace @cloudflare/computer
npx wrangler login
npm run dev --workspace @cloudflare/example-rlm
```

Open the Vite URL, normally <http://localhost:5173>, and choose **Run comparison**. The Structured RLM lane starts first. As soon as its map work begins, both baselines start together so the expensive parts overlap without making the RLM parent compete to author its program. You can cancel the complete comparison or stop one lane. Durations reflect shared provider load and are not controlled benchmark timings.

The authenticated Workers AI binding is the default. If local Access policy blocks that binding, copy the optional REST fallback:

```sh
cp examples/rlm/.dev.vars.example examples/rlm/.dev.vars
```

Set `WORKERS_AI_USE_REST=true`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`, then restart Vite. `.dev.vars` is ignored and must not be committed.

## What to look for

Start with **Classify 2,433 records** and compare the lanes:

- **Direct context** asks one model to interpret and aggregate the whole corpus in one generation.
- **JavaScript only** can read every byte and count perfectly, but it has no semantic function that labels the sentences.
- **Structured RLM** exposes semantic inference as a bounded function inside generated JavaScript.

In the RLM lane, look for:

- One map worker for each Workspace partition.
- A compact JSON schema for each semantic map call.
- `Validated model JSON → JavaScript reduce`.
- Separate parent, map, and total token counts.
- The complete generated module and its bounded answer.

The reducer is exact relative to its inputs. Model classifications can still be wrong, so an RLM does not make probabilistic inference deterministic.

## Explore the code

The shortest path through the example is:

1. [`worker/rlm-agent.ts`](worker/rlm-agent.ts) wires together the model, Workspace, Worker JavaScript backend, executor tool, and `ws:model`.
2. [`worker/capability.ts`](worker/capability.ts) implements the bounded `batch(requests)` function behind `ws:model`.
3. [`worker/structured-rlm.ts`](worker/structured-rlm.ts) describes the map result and JavaScript reduction for each task family.
4. [`worker/agent-common.ts`](worker/agent-common.ts) writes the same corpus into each Computer Workspace.
5. [`worker/executor-tool.ts`](worker/executor-tool.ts) creates the native Computer executor tool and keeps its browser-facing result small.
6. [`src/App.tsx`](src/App.tsx) runs the three strategies and renders their traces side by side.

The two baselines live in [`worker/direct-agent.ts`](worker/direct-agent.ts) and [`worker/executor-agent.ts`](worker/executor-agent.ts). Most other files load and score Oolong data or render the comparison UI; the RLM integration itself is concentrated in the first three files above.

## Bounds used by the example

`ws:model` is deliberately small and predictable:

- Up to 24 model requests in one run.
- Up to four model calls at a time.
- Up to 16 KiB of instructions and 48 KiB of input per request.
- Up to 1,024 output tokens per request.
- One host-selected model for parent and map calls: `@cf/zai-org/glm-5.2`.
- Abort propagation from the browser through generated execution and active model calls.

These are example limits, not requirements of `@cloudflare/computer`. Change them in [`worker/capability.ts`](worker/capability.ts) to match your task and model.

## Demo data

The UI uses official [Oolong-synth](https://huggingface.co/datasets/oolongbench/oolong-synth) and [Oolong-real](https://huggingface.co/datasets/oolongbench/oolong-real) tasks. It fetches rows at runtime, checks their complete source hashes, and scores answers with a TypeScript version of the official evaluator.

The selected rows, revisions, and hashes live in [`benchmarks/development.json`](benchmarks/development.json). Raw dataset rows are not stored in this repository.

This is an independent Computer-backed example of the RLM method described in [Prime Intellect's RLM evaluation](https://www.primeintellect.ai/blog/rlm), not a reproduction of their run or an aggregate benchmark. The task-aware schemas and reducers make this a **Structured RLM** example.

Oolong-real is derived from CRD3 material licensed CC BY-SA 4.0. Oolong-synth's Hugging Face card does not declare a dataset license. Review the upstream terms before redistributing fetched data.

## Verify changes

```sh
npm test --workspace @cloudflare/example-rlm
npm run typecheck --workspace @cloudflare/example-rlm
npm run build --workspace @cloudflare/example-rlm
```

The build checks that local secret files and values do not appear in `dist`.

## Optional deployment

This repository example is designed for learning and local experiments, not as a public multi-user application. If you deploy it, set a strong token before exposing the Worker:

```sh
cd examples/rlm
openssl rand -hex 32 | npx wrangler secret put DEMO_TOKEN
cd ../..
npm run deploy --workspace @cloudflare/example-rlm
```

The token protects access to the costly model routes. Add your own access control, rate limits, usage monitoring, and Workspace retention policy for a shared or long-lived deployment.
