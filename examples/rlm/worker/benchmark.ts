import { z } from "zod";

import type {
  BenchmarkRequest,
  OolongRealSample,
  OolongSampleMetadata,
  OolongScore,
} from "../shared/types";
import { summarizeParsedAnswer } from "./score-summary";

export const OOLONG_TASK_ID = "oolong-real-dnd-v1" as const;
export const OOLONG_DATASET = "oolongbench/oolong-real" as const;
export const OOLONG_CONFIG = "dnd" as const;
export const OOLONG_SPLIT = "test" as const;
export const OOLONG_DATASET_REVISION = "6bc9ef04866fcf005c9749b70649be69dd37fffb" as const;
export const OOLONG_REAL_ROW_INDICES = [0, 30, 35, 39, 2500] as const;
export const OOLONG_CONTEXT_CHUNK_BYTES = 44 * 1024;
export const OOLONG_FETCH_TIMEOUT_MS = 10_000;
export const OOLONG_CONTEXT_PATH = "/workspace/oolong-real/context.txt" as const;
export const OOLONG_MANIFEST_PATH = "/workspace/oolong-real/manifest.json" as const;

const DATASETS_SERVER_ROWS_URL = "https://datasets-server.huggingface.co/rows";
const SAMPLE_ROWS: Record<OolongRealSample, OolongRealRowIndex> = {
  rolls: 0,
  "spell-order": 30,
  "rare-spells": 35,
  "upcast-spells": 39,
  "long-spell-sequence": 2500,
};
const PUBLISHED_FIXTURES: Record<number, { id: string; contextHash: string; sourceHash: string }> =
  {
    0: {
      id: "12b8de0b-a61e-9b26-2297-55661f2700d5",
      contextHash: "fnv1a-096d07ab",
      sourceHash: "fnv1a-dc0a79c6",
    },
    30: {
      id: "693f075c-7b35-d490-2256-e2575077418a",
      contextHash: "fnv1a-096d07ab",
      sourceHash: "fnv1a-4ae660b9",
    },
    35: {
      id: "73839941-f137-e848-8576-485c60199755",
      contextHash: "fnv1a-096d07ab",
      sourceHash: "fnv1a-69b7b188",
    },
    39: {
      id: "405c8936-28e9-31ea-0be4-0a30e9b8d7ac",
      contextHash: "fnv1a-096d07ab",
      sourceHash: "fnv1a-3e479894",
    },
    2500: {
      id: "8afe6227-ad7b-7903-63c5-d39884b55cbe",
      contextHash: "fnv1a-5cccae83",
      sourceHash: "fnv1a-385d828a",
    },
  };
const runFields = {
  runId: z.string().uuid(),
  order: z.number().int().min(0).max(2).optional(),
};
const benchmarkRequestSchema = z
  .object({
    benchmark: z.discriminatedUnion("taskId", [
      z
        .object({
          taskId: z.literal(OOLONG_TASK_ID),
          sample: z.enum([
            "rolls",
            "spell-order",
            "rare-spells",
            "upcast-spells",
            "long-spell-sequence",
          ]),
          ...runFields,
        })
        .strict(),
      z
        .object({
          taskId: z.literal("oolong-synth-v1"),
          sample: z.literal("synth-frequency"),
          ...runFields,
        })
        .strict(),
    ]),
  })
  .strict();
const MAX_ROWS_RESPONSE_BYTES = 32 * 1024 * 1024;

const externalRowSchema = z.object({
  row_idx: z.number().int().nonnegative(),
  row: z.object({
    id: z.string().min(1),
    context_window_id: z.string().min(1),
    context_window_text: z.string(),
    question: z.string().min(1),
    answer: z.string(),
    question_type: z.string().min(1),
    episodes: z.array(z.number().int()),
    campaign: z.string().min(1),
  }),
});

const externalRowsResponseSchema = z.object({
  rows: z.array(externalRowSchema).length(1),
});

export type OolongRealRowIndex = (typeof OOLONG_REAL_ROW_INDICES)[number];
export type OolongParsedAnswer = number | string | string[];
export type OolongParseConfidence = "high" | "low";

export interface OolongRowSelector {
  dataset: typeof OOLONG_DATASET;
  config: typeof OOLONG_CONFIG;
  split: typeof OOLONG_SPLIT;
  rowIndex: OolongRealRowIndex;
}

export interface OolongRealRow {
  rowIndex: number;
  id: string;
  contextWindowId: string;
  context: string;
  question: string;
  answer: string;
  questionType: string;
  episodes: number[];
  campaign: string;
}

export interface OolongContextChunkManifest {
  index: number;
  path: string;
  hash: string;
  byteLength: number;
  episode: number | null;
  partIndex: number;
  startByte: number;
  endByte: number;
}

export interface OolongFixtureManifest {
  version: 1;
  taskId: typeof OOLONG_TASK_ID;
  dataset: typeof OOLONG_DATASET;
  config: typeof OOLONG_CONFIG;
  split: typeof OOLONG_SPLIT;
  rowIndex: number;
  id: string;
  contextWindowId: string;
  question: string;
  questionType: string;
  episodes: number[];
  campaign: string;
  contextPath: typeof OOLONG_CONTEXT_PATH;
  contextHash: string;
  contextBytes: number;
  contextChunkBytes: number;
  contextChunks: OolongContextChunkManifest[];
  fixtureHash: string;
}

export interface OolongRealFixture {
  kind: "real";
  manifest: OolongFixtureManifest;
  context: string;
  chunks: string[];
  contextHash: string;
  fixtureHash: string;
  goldAnswer: string;
}

export interface OolongDndScore {
  score: number;
  gold: OolongParsedAnswer;
  attemptedParse: OolongParsedAnswer;
  parseConfidence: OolongParseConfidence;
  fullAnswer: string;
}

export interface FetchOolongRealRowOptions {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

export function parseBenchmarkRequest(value: unknown): BenchmarkRequest["benchmark"] {
  const parsed = benchmarkRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid Oolong benchmark request.");
  return parsed.data.benchmark;
}

export function rowForSample(sample: OolongRealSample): OolongRealRowIndex {
  return SAMPLE_ROWS[sample];
}

export function verifyPublishedFixture(fixture: OolongRealFixture): void {
  const expected = PUBLISHED_FIXTURES[fixture.manifest.rowIndex];
  if (
    !expected ||
    expected.id !== fixture.manifest.id ||
    expected.contextHash !== fixture.contextHash ||
    expected.sourceHash !== hashOolongSourceFixture(fixture)
  ) {
    throw new Error("Oolong sample did not match the published fixture manifest.");
  }
}

export function sampleMetadata(fixture: OolongRealFixture): OolongSampleMetadata {
  return {
    dataset: OOLONG_DATASET,
    datasetRevision: OOLONG_DATASET_REVISION,
    config: OOLONG_CONFIG,
    split: OOLONG_SPLIT,
    row: fixture.manifest.rowIndex,
    id: fixture.manifest.id,
    contextWindowId: fixture.manifest.contextWindowId,
    questionType: fixture.manifest.questionType,
    question: fixture.manifest.question,
    contextBytes: fixture.manifest.contextBytes,
    contextHash: fixture.contextHash,
    chunkCount: fixture.chunks.length,
  };
}

export function scoreExecutionValue(goldAnswer: string, value: unknown): OolongScore {
  const candidate = isRecord(value) && Object.hasOwn(value, "answer") ? value.answer : value;
  const answer = Array.isArray(candidate) ? candidate.join(", ") : String(candidate ?? "");
  return toSharedScore(scoreOolongDndResponse(goldAnswer, `\\boxed{${answer}}`));
}

export function scoreTextResponse(goldAnswer: string, text: string): OolongScore {
  return toSharedScore(scoreOolongDndResponse(goldAnswer, text));
}

export function selectOolongRealRow(selection: number): OolongRowSelector {
  if (
    !Number.isInteger(selection) ||
    selection < 0 ||
    selection >= OOLONG_REAL_ROW_INDICES.length
  ) {
    throw new Error("Invalid Oolong-real selection.");
  }
  const rowIndex = OOLONG_REAL_ROW_INDICES[selection];
  if (rowIndex === undefined) throw new Error("Invalid Oolong-real selection.");
  return {
    dataset: OOLONG_DATASET,
    config: OOLONG_CONFIG,
    split: OOLONG_SPLIT,
    rowIndex,
  };
}

export function parseOolongRowsResponse(value: unknown, expectedRowIndex: number): OolongRealRow {
  const parsed = externalRowsResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid Oolong rows response.");
  const external = parsed.data.rows[0];
  if (!external) throw new Error("Invalid Oolong rows response.");
  if (external.row_idx !== expectedRowIndex) {
    throw new Error(
      `Oolong rows response returned unexpected row ${external.row_idx}; expected ${expectedRowIndex}.`,
    );
  }
  return {
    rowIndex: external.row_idx,
    id: external.row.id,
    contextWindowId: external.row.context_window_id,
    context: external.row.context_window_text,
    question: external.row.question,
    answer: external.row.answer,
    questionType: external.row.question_type,
    episodes: external.row.episodes,
    campaign: external.row.campaign,
  };
}

export async function fetchOolongRealRow(
  rowIndex: number,
  options: FetchOolongRealRowOptions = {},
): Promise<OolongRealRow> {
  assertCuratedRowIndex(rowIndex);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(
      new Error(`Oolong rows request timed out after ${OOLONG_FETCH_TIMEOUT_MS}ms.`),
    );
  }, OOLONG_FETCH_TIMEOUT_MS);

  const url = new URL(DATASETS_SERVER_ROWS_URL);
  url.searchParams.set("dataset", OOLONG_DATASET);
  url.searchParams.set("config", OOLONG_CONFIG);
  url.searchParams.set("split", OOLONG_SPLIT);
  url.searchParams.set("offset", String(rowIndex));
  url.searchParams.set("length", "1");

  try {
    const response = await fetcher(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Oolong rows request failed with HTTP ${response.status}.`);
    }
    const body = await readBoundedJson(response);
    return parseOolongRowsResponse(body, rowIndex);
  } catch (error) {
    if (timedOut) {
      throw new Error(`Oolong rows request timed out after ${OOLONG_FETCH_TIMEOUT_MS}ms.`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function splitUtf8Context(context: string, maxBytes = OOLONG_CONTEXT_CHUNK_BYTES): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new Error("Oolong context chunks must allow at least 4 bytes.");
  }
  const encoded = new TextEncoder().encode(context);
  if (encoded.byteLength === 0) return [];

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const chunks: string[] = [];
  let start = 0;
  while (start < encoded.byteLength) {
    let end = Math.min(start + maxBytes, encoded.byteLength);
    if (end < encoded.byteLength) {
      while (end > start && isUtf8ContinuationByte(encoded[end])) end -= 1;
    }
    if (end === start) throw new Error("Unable to find a UTF-8 boundary for the context chunk.");
    chunks.push(decoder.decode(encoded.subarray(start, end)));
    start = end;
  }
  return chunks;
}

interface OolongSemanticChunk {
  text: string;
  episode: number | null;
  partIndex: number;
  startByte: number;
  endByte: number;
}

export function splitOolongEpisodes(context: string, episodes: number[]): OolongSemanticChunk[] {
  const encoder = new TextEncoder();
  const startMarker = "[START OF EPISODE]";
  const endMarker = "[END OF EPISODE]";
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < context.length) {
    const start = context.indexOf(startMarker, cursor);
    if (start < 0) break;
    const endMarkerStart = context.indexOf(endMarker, start + startMarker.length);
    if (endMarkerStart < 0) break;
    const end = endMarkerStart + endMarker.length;
    if (encoder.encode(context.slice(start, end)).byteLength >= 1024) ranges.push({ start, end });
    cursor = end;
  }

  if (ranges.length !== episodes.length) {
    let startByte = 0;
    return splitUtf8Context(context).map((text, partIndex) => {
      const byteLength = encoder.encode(text).byteLength;
      const chunk = {
        text,
        episode: episodes.length === 1 ? (episodes[0] ?? null) : null,
        partIndex,
        startByte,
        endByte: startByte + byteLength,
      };
      startByte += byteLength;
      return chunk;
    });
  }

  return ranges.flatMap((range, episodeIndex) => {
    const rangeStartByte = encoder.encode(context.slice(0, range.start)).byteLength;
    let localStartByte = 0;
    return splitUtf8Context(context.slice(range.start, range.end)).map((text, partIndex) => {
      const byteLength = encoder.encode(text).byteLength;
      const chunk = {
        text,
        episode: episodes[episodeIndex] ?? null,
        partIndex,
        startByte: rangeStartByte + localStartByte,
        endByte: rangeStartByte + localStartByte + byteLength,
      };
      localStartByte += byteLength;
      return chunk;
    });
  });
}

export function createOolongRealFixture(row: OolongRealRow): OolongRealFixture {
  assertCuratedRowIndex(row.rowIndex);
  const encoder = new TextEncoder();
  const semanticChunks = splitOolongEpisodes(row.context, row.episodes);
  const chunks = semanticChunks.map((chunk) => chunk.text);
  const contextBytes = encoder.encode(row.context).byteLength;
  const contextHash = fnv1a(row.context);
  const contextChunks = semanticChunks.map((chunk, index): OolongContextChunkManifest => ({
    index,
    path: `/workspace/oolong-real/context-${String(index).padStart(4, "0")}.txt`,
    hash: fnv1a(chunk.text),
    byteLength: encoder.encode(chunk.text).byteLength,
    episode: chunk.episode,
    partIndex: chunk.partIndex,
    startByte: chunk.startByte,
    endByte: chunk.endByte,
  }));
  const publicFixture = {
    version: 1 as const,
    taskId: OOLONG_TASK_ID,
    dataset: OOLONG_DATASET,
    config: OOLONG_CONFIG,
    split: OOLONG_SPLIT,
    rowIndex: row.rowIndex,
    id: row.id,
    contextWindowId: row.contextWindowId,
    question: row.question,
    questionType: row.questionType,
    episodes: row.episodes,
    campaign: row.campaign,
    contextPath: OOLONG_CONTEXT_PATH,
    contextHash,
    contextBytes,
    contextChunkBytes: OOLONG_CONTEXT_CHUNK_BYTES,
    contextChunks,
  };
  const fixtureHash = fnv1a(stableJson(publicFixture));
  const manifest: OolongFixtureManifest = { ...publicFixture, fixtureHash };
  return {
    kind: "real",
    manifest,
    context: row.context,
    chunks,
    contextHash,
    fixtureHash,
    goldAnswer: row.answer,
  };
}

export function scoreOolongDndResponse(goldAnswer: string, output: string): OolongDndScore {
  const gold = parseOolongDndAnswer(goldAnswer);
  const parsedResponse = parseOolongDndResponse(output);
  const attemptedParse = parsedResponse.answer;
  let score = 0;

  if (typeof gold === "number" && typeof attemptedParse === "number") {
    score = 0.75 ** Math.abs(gold - attemptedParse);
  } else if (typeof gold === "string" && typeof attemptedParse === "string") {
    score = Number(gold.trim().toLowerCase() === attemptedParse.trim().toLowerCase());
  } else if (Array.isArray(gold) && Array.isArray(attemptedParse)) {
    const goldSet = new Set(gold);
    const attempted = new Set(attemptedParse);
    const overlap = new Set([...goldSet].filter((item) => attempted.has(item)));
    score = goldSet.size === 0 ? 0 : overlap.size / goldSet.size;
  }

  return {
    score,
    gold,
    attemptedParse,
    parseConfidence: parsedResponse.confidence,
    fullAnswer: output,
  };
}

export function parseOolongDndAnswer(answer: string): OolongParsedAnswer {
  const trimmed = answer.trim();
  if (/^[+-]?\d+$/.test(trimmed)) {
    const integer = Number(trimmed);
    if (Number.isSafeInteger(integer)) return integer;
  }
  if (answer.includes(",")) {
    return answer
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return answer;
}

export function parseOolongDndResponse(output: string): {
  answer: OolongParsedAnswer;
  confidence: OolongParseConfidence;
} {
  const textBox = output.match(/\\boxed\{\\text\{([^}]*)\}\}/);
  const genericBox = output.match(/\\boxed\{+([^}]*)\}+/);
  const boxed = textBox?.[1] ?? genericBox?.[1];
  if (boxed === undefined) return { answer: output, confidence: "low" };
  return { answer: parseOolongDndAnswer(boxed), confidence: "high" };
}

function assertCuratedRowIndex(rowIndex: number): asserts rowIndex is OolongRealRowIndex {
  if (!(OOLONG_REAL_ROW_INDICES as readonly number[]).includes(rowIndex)) {
    throw new Error(`Oolong-real row ${rowIndex} is not curated.`);
  }
}

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ROWS_RESPONSE_BYTES) {
    throw new Error("Oolong rows response exceeded the byte limit.");
  }
  if (!response.body) throw new Error("Oolong rows response had no body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ROWS_RESPONSE_BYTES) {
        await reader.cancel("Oolong rows response exceeded the byte limit.");
        throw new Error("Oolong rows response exceeded the byte limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new Error("Oolong rows response was not valid UTF-8 JSON.", { cause: error });
  }
}

export function hashOolongSourceFixture(fixture: OolongRealFixture): string {
  return fnv1a(
    stableJson({
      rowIndex: fixture.manifest.rowIndex,
      id: fixture.manifest.id,
      contextWindowId: fixture.manifest.contextWindowId,
      context: fixture.context,
      question: fixture.manifest.question,
      answer: fixture.goldAnswer,
      questionType: fixture.manifest.questionType,
      episodes: fixture.manifest.episodes,
      campaign: fixture.manifest.campaign,
    }),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  );
}

function toSharedScore(score: OolongDndScore): OolongScore {
  return {
    score: score.score,
    attemptedParse: summarizeParsedAnswer(score.attemptedParse),
    parseConfidence: score.parseConfidence,
    answer: score.gold,
    answerType:
      typeof score.gold === "number" ? "integer" : Array.isArray(score.gold) ? "list" : "string",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
