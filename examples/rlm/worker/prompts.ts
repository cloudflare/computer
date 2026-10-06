import type { BenchmarkFixture } from "./fixture-types";

export const PARENT_GENERATION_SETTINGS = {
  maxOutputTokens: 4096,
  temperature: 0,
} as const;
export const RLM_PARENT_GENERATION_SETTINGS = {
  maxOutputTokens: 6144,
  temperature: 0,
} as const;
export const DIRECT_SYSTEM_PROMPT = "You are a helpful assistant.";

export const EXECUTOR_SYSTEM_PROMPT = `Solve the Oolong benchmark with Computer's JavaScript Executor, then answer briefly.

The executor command must be a complete ES module with export default async function. Use import fs from "node:fs/promises". Read /workspace/oolong-real/manifest.json, then read the documented contextChunks. Compute the answer from the corpus and return { answer } from the default function. Do not make manifest-inspection or schema-discovery calls. Do not return candidate lines, diagnostics, or the corpus in place of the answer. You have no model calls inside execution. Scoring uses a typed { answer } execution result, not stdout or final prose.`;

export const RLM_SYSTEM_PROMPT = `Solve the Oolong benchmark with one comprehensive recursive Computer execution, then answer briefly.

The executor command must be a complete ES module with export default async function. Use import fs from "node:fs/promises" and import { batch } from "ws:model". Read /workspace/oolong-real/manifest.json. Its contextChunks contain the long corpus.

Use Computer as an RLM. Do not make manifest-inspection, schema-discovery, or diagnostic-only calls:
1. Read the bounded corpus chunks.
2. You have one child-call budget of 24 total requests. Call batch(requests) exactly once with at most 24 focused requests. Each request is { prompt, input }; keep each input to one chunk and ask for structured, question-specific evidence.
3. Each child result is { index, ok, text, error }. Aggregate successful findings in JavaScript and tolerate failed workers. For first/last-event questions, retain chunk indexes and choose evidence by transcript position; never replace an earlier event with a later, more salient one.
4. Parse the child text, aggregate findings in corpus chunk order, and return { answer } from the default function. If a later execution is needed to finalize from prior findings, it must still return { answer }.

Never merely log child findings or return null. Do not return the corpus or child responses. Child calls have no tools. Scoring uses a typed { answer } execution result, not stdout or final prose.`;

export function directSystemPrompt(fixture: BenchmarkFixture): string {
  return `${DIRECT_SYSTEM_PROMPT}\n\n${fixture.context}`;
}

export function directPrompt(fixture: BenchmarkFixture): string {
  if (fixture.kind === "synth") return fixture.manifest.question;
  return `${fixture.manifest.question}\n\nReturn only \\boxed{ANSWER}, with comma-separated values inside the box when requested.`;
}

export function computerPrompt(fixture: BenchmarkFixture, lane: "executor" | "rlm"): string {
  return [
    `Official ${fixture.manifest.dataset} sample ${fixture.manifest.id}.`,
    `Question: ${fixture.manifest.question}`,
    `The corpus is stored as ${fixture.chunks.length} bounded files listed in /workspace/oolong-real/manifest.json.`,
    lane === "rlm"
      ? "Use recursive child inference selectively and aggregate its findings."
      : "Use JavaScript analysis over the Workspace files.",
  ].join("\n");
}
