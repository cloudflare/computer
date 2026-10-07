// pi's Workers AI provider, transported over the `AI` binding rather
// than the REST endpoint, so the example needs no API key. Only the
// transport differs from pi's own provider.
//
// Lifted from the pi harness example in cloudflare/agents.

import {
  type ApiStreamOptions,
  createProvider,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const WORKERS_AI_PROVIDER = "cloudflare-workers-ai";

type RunBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options: { returnRawResponse: true; signal?: AbortSignal },
  ): Promise<Response>;
};

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  throw new TypeError("Workers AI pi requests require a JSON request body");
}

function model(id: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: WORKERS_AI_PROVIDER,
    // Never dialed: the fetch below answers every request through the
    // binding instead. pi still wants a syntactically valid base URL.
    baseUrl: "https://workers-ai.binding.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
  };
}

export function workersAI(binding: Ai, modelId: string) {
  // SAFETY: Workers AI returns a Response when `returnRawResponse` is
  // set. The public `Ai` overload cannot express that correlation.
  const runBinding = binding as unknown as RunBinding;

  const fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const input = JSON.parse(bodyText(init?.body)) as Record<string, unknown>;
    const name = typeof input.model === "string" ? input.model : undefined;
    if (!name) throw new TypeError("Workers AI pi request is missing its model");
    delete input.model;
    return runBinding.run(name, input, {
      returnRawResponse: true,
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  };

  const api = openAICompletionsApi();
  const streams: ProviderStreams = {
    stream: (m, context, options) =>
      api.stream(m, context, { ...options, fetch } as ApiStreamOptions<string>),
    streamSimple: (m, context, options) => api.streamSimple(m, context, { ...options, fetch }),
  };

  return createProvider({
    id: WORKERS_AI_PROVIDER,
    name: "Cloudflare Workers AI",
    // The binding carries its own authorization, so there is no key to
    // resolve. pi still requires every provider to declare auth.
    auth: {
      apiKey: {
        name: "Workers AI binding",
        check: async () => ({ type: "api_key" as const, source: "Workers AI binding" }),
        resolve: async () => ({
          auth: { apiKey: "workers-ai-binding" },
          source: "Workers AI binding",
        }),
      },
    },
    models: [model(modelId)],
    api: streams,
  });
}
