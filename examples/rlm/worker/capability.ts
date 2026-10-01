import type { WorkspaceModuleFunction, WorkspaceRuntimeValue } from "@cloudflare/computer";
import { generateText, type LanguageModel } from "ai";
import { z } from "zod";

const MAX_CHILD_REQUESTS = 24;
const MAX_CONCURRENCY = 4;
const MAX_PROMPT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 48 * 1024;
const MAX_AGGREGATE_REQUEST_BYTES = 1_179_648;
const MAX_OUTPUT_TOKENS = 1024;
const CHILD_SYSTEM_PROMPT = [
  "You are a focused recursive inference worker.",
  "Follow the supplied instruction using only the supplied input.",
  "Return a concise answer. Do not invent evidence or claim access to tools.",
].join("\n");

const jsonValueSchema: z.ZodType<WorkspaceRuntimeValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const childRequestSchema = z
  .object({
    prompt: z.string(),
    input: jsonValueSchema.optional(),
  })
  .strict();

interface ChildRequest {
  prompt: string;
  input: WorkspaceRuntimeValue;
}

interface ChildResult {
  [key: string]: WorkspaceRuntimeValue;
  id: string;
  index: number;
  ok: boolean;
  text: string;
  error: string | null;
}

interface UsageMetadata {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

interface StartedMetadata {
  id: string;
  index: number;
}

interface CompletedMetadata extends StartedMetadata {
  durationMs: number;
  usage: UsageMetadata;
}

interface FailedMetadata extends CompletedMetadata {
  error: string;
}

interface ChildHooks {
  admit?(requests: number): boolean;
  started(metadata: StartedMetadata): void;
  completed(metadata: CompletedMetadata): void;
  failed(metadata: FailedMetadata): void;
}

/** The `ws:model` trusted module: one `batch` function over bounded child requests. */
export type ModelCapability = {
  /** Run up to 24 child model requests and return one result per request. */
  readonly batch: WorkspaceModuleFunction;
};

export function createModelCapability(model: LanguageModel, hooks: ChildHooks): ModelCapability {
  return {
    async batch(args, context) {
      const requests = parseBatchArgs(args);
      if (hooks.admit && !hooks.admit(requests.length)) {
        throw new Error("This run has exhausted its child-model call budget.");
      }
      const signal = context.signal;
      throwIfAborted(signal);

      const results: Array<ChildResult | undefined> = new Array(requests.length);
      let nextIndex = 0;
      let firstError: unknown;

      const worker = async () => {
        while (true) {
          if (signal?.aborted) {
            firstError ??= abortReason(signal);
            return;
          }
          const index = nextIndex;
          if (index >= requests.length) return;
          nextIndex += 1;
          const request = requests[index];
          if (!request) return;
          try {
            results[index] = await runChild(model, hooks, request, index, signal);
          } catch (error) {
            firstError ??= error;
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENCY, requests.length) }, () => worker()),
      );
      if (firstError !== undefined) throw firstError;
      return results as ChildResult[];
    },
  };
}

async function runChild(
  model: LanguageModel,
  hooks: ChildHooks,
  request: ChildRequest,
  index: number,
  signal: AbortSignal | undefined,
): Promise<ChildResult> {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  notify(() => hooks.started({ id, index }));

  try {
    const result = await generateText({
      model,
      abortSignal: signal,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      system: CHILD_SYSTEM_PROMPT,
      prompt: formatChildPrompt(request),
    });
    notify(() =>
      hooks.completed({
        id,
        index,
        durationMs: Date.now() - startedAt,
        usage: normalizeUsage(result.usage),
      }),
    );
    return { id, index, ok: true, text: result.text, error: null };
  } catch (error) {
    const message = boundedError(error);
    notify(() =>
      hooks.failed({
        id,
        index,
        error: message,
        durationMs: Date.now() - startedAt,
        usage: usageFromFailure(error),
      }),
    );
    if (signal?.aborted) throw error;
    return { id, index, ok: false, text: "", error: message };
  }
}

function parseBatchArgs(args: readonly WorkspaceRuntimeValue[]): ChildRequest[] {
  if (args.length !== 1) throw new Error("Model batch requires exactly one argument.");
  const value = args[0];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Model batch requires a non-empty array of requests.");
  }
  if (value.length > MAX_CHILD_REQUESTS) {
    throw new Error(`Model batch cannot exceed ${MAX_CHILD_REQUESTS} requests.`);
  }
  if (encodedBytes(value) > MAX_AGGREGATE_REQUEST_BYTES) {
    throw new Error(`Model batch request cannot exceed ${MAX_AGGREGATE_REQUEST_BYTES} bytes.`);
  }

  return value.map((candidate) => {
    const parsed = childRequestSchema.safeParse(candidate);
    if (!parsed.success) throw new Error("Invalid batch request.");
    const prompt = parsed.data.prompt;
    if (prompt.trim().length === 0) throw new Error("Model request requires a prompt.");
    if (encodedTextBytes(prompt) > MAX_PROMPT_BYTES) {
      throw new Error(`Model prompt cannot exceed ${MAX_PROMPT_BYTES} bytes.`);
    }
    const input = parsed.data.input ?? null;
    if (encodedBytes(input) > MAX_INPUT_BYTES) {
      throw new Error(`Model input cannot exceed ${MAX_INPUT_BYTES} bytes.`);
    }
    return { prompt, input };
  });
}

function formatChildPrompt(request: ChildRequest): string {
  return `${request.prompt}\n\nInput:\n${JSON.stringify(request.input)}`;
}

function normalizeUsage(value: unknown): UsageMetadata {
  const usage = isRecord(value) ? value : {};
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
    totalTokens: tokenCount(usage.totalTokens),
  };
}

function usageFromFailure(error: unknown): UsageMetadata {
  return normalizeUsage(isRecord(error) ? error.usage : null);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function encodedTextBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodedBytes(value: WorkspaceRuntimeValue): number {
  return encodedTextBytes(JSON.stringify(value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function notify(callback: () => void): void {
  try {
    callback();
  } catch {
    // Observability hooks cannot change inference behavior.
  }
}
