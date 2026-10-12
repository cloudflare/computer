import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOolongRealFixture,
  fetchOolongRealRow,
  hashOolongSourceFixture,
  OOLONG_CONTEXT_CHUNK_BYTES,
  OOLONG_REAL_ROW_INDICES,
  type OolongRealRow,
  parseBenchmarkRequest,
  parseOolongRowsResponse,
  scoreOolongDndResponse,
  selectOolongRealRow,
  splitUtf8Context,
} from "./benchmark";

const ROW: OolongRealRow = {
  rowIndex: 30,
  id: "question-30",
  contextWindowId: "window-30",
  context: "The campaign transcript includes a wizard and a dragon.",
  question: "How many times was fireball cast?",
  answer: "GOLD_SECRET",
  questionType: "numeric",
  episodes: [2],
  campaign: "campaign1",
};

function rowsPayload(row: OolongRealRow = ROW): unknown {
  return {
    features: [{ feature_idx: 0, name: "id", type: { dtype: "string" } }],
    rows: [
      {
        row_idx: row.rowIndex,
        row: {
          id: row.id,
          context_window_id: row.contextWindowId,
          context_window_text: row.context,
          question: row.question,
          answer: row.answer,
          question_type: row.questionType,
          episodes: row.episodes,
          campaign: row.campaign,
        },
        truncated_cells: [],
      },
    ],
    num_rows_total: 100,
    num_rows_per_page: 1,
    partial: false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("benchmark requests", () => {
  it("accepts paired real and synthetic task identifiers", () => {
    expect(
      parseBenchmarkRequest({
        benchmark: {
          taskId: "oolong-real-dnd-v1",
          sample: "spell-order",
          runId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    ).toMatchObject({ sample: "spell-order" });
    expect(
      parseBenchmarkRequest({
        benchmark: {
          taskId: "oolong-synth-v1",
          sample: "synth-frequency",
          runId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    ).toMatchObject({ sample: "synth-frequency" });
  });

  it("rejects task and sample mismatches", () => {
    expect(() =>
      parseBenchmarkRequest({
        benchmark: {
          taskId: "oolong-real-dnd-v1",
          sample: "synth-frequency",
          runId: "00000000-0000-4000-8000-000000000000",
        },
      }),
    ).toThrow("Invalid Oolong benchmark request");
  });
});

describe("server-owned Oolong-real selection", () => {
  it("exposes only the curated initial rows", () => {
    expect(OOLONG_REAL_ROW_INDICES).toEqual([0, 30, 35, 39, 2500]);
    expect(selectOolongRealRow(2)).toMatchObject({
      dataset: "oolongbench/oolong-real",
      config: "dnd",
      split: "test",
      rowIndex: 35,
    });
    expect(() => selectOolongRealRow(-1)).toThrow("Invalid Oolong-real selection");
    expect(() => selectOolongRealRow(5)).toThrow("Invalid Oolong-real selection");
  });
});

describe("Hugging Face rows adapter", () => {
  it("parses the external unknown response into the local row type", () => {
    expect(parseOolongRowsResponse(rowsPayload(), 30)).toEqual(ROW);
  });

  it.each([
    null,
    {},
    { rows: [] },
    { rows: [{ row_idx: 30, row: { ...ROW } }] },
    {
      rows: [
        {
          row_idx: 30,
          row: {
            id: "id",
            context_window_id: "window",
            context_window_text: 123,
            question: "question",
            answer: "answer",
            question_type: "type",
            campaign: "campaign",
          },
        },
      ],
    },
  ])("rejects malformed external JSON", (value) => {
    expect(() => parseOolongRowsResponse(value, 30)).toThrow("Invalid Oolong rows response");
  });

  it("rejects a valid row returned for a different offset", () => {
    expect(() => parseOolongRowsResponse(rowsPayload({ ...ROW, rowIndex: 35 }), 30)).toThrow(
      "unexpected row",
    );
  });

  it("fetches exactly one curated row from the datasets-server endpoint", async () => {
    let requestedUrl = "";
    let requestedSignal: AbortSignal | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      requestedUrl = String(input);
      requestedSignal = init?.signal ?? null;
      return new Response(JSON.stringify(rowsPayload()), {
        headers: { "content-type": "application/json" },
      });
    };

    await expect(fetchOolongRealRow(30, { fetcher })).resolves.toEqual(ROW);
    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe("https://datasets-server.huggingface.co/rows");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      dataset: "oolongbench/oolong-real",
      config: "dnd",
      split: "test",
      offset: "30",
      length: "1",
    });
    expect(requestedSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a stalled rows request after ten seconds", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });

    const pending = fetchOolongRealRow(30, { fetcher });
    // oxlint-disable-next-line vitest/valid-expect -- awaited below, after the timers advance
    const rejection = expect(pending).rejects.toThrow("timed out after 10000ms");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("rejects non-curated row offsets before making a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchOolongRealRow(1, { fetcher })).rejects.toThrow(
      "Oolong-real row 1 is not curated",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("bounded Oolong context chunks", () => {
  it("is deterministic, lossless, UTF-8-safe, and bounded around 32 KiB", () => {
    const context = `${"a".repeat(OOLONG_CONTEXT_CHUNK_BYTES - 1)}😀${"界".repeat(20_000)}`;
    const first = splitUtf8Context(context);
    const second = splitUtf8Context(context);

    expect(first).toEqual(second);
    expect(first.join("")).toBe(context);
    expect(first.length).toBeGreaterThan(2);
    for (const chunk of first) {
      expect(new TextEncoder().encode(chunk).byteLength).toBeLessThanOrEqual(
        OOLONG_CONTEXT_CHUNK_BYTES,
      );
      expect(() =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          new TextEncoder().encode(chunk),
        ),
      ).not.toThrow();
    }
  });

  it("handles empty context and rejects unsafe byte limits", () => {
    expect(splitUtf8Context("")).toEqual([]);
    expect(() => splitUtf8Context("hello", 3)).toThrow("at least 4 bytes");
  });
});

describe("Oolong fixture manifest", () => {
  it("creates stable public hashes without exposing the gold answer", () => {
    const first = createOolongRealFixture(ROW);
    const second = createOolongRealFixture({ ...ROW });
    const changedContext = createOolongRealFixture({ ...ROW, context: `${ROW.context}!` });
    const changedAnswer = createOolongRealFixture({ ...ROW, answer: "OTHER_SECRET" });

    expect(first).toEqual(second);
    expect(first.contextHash).not.toBe(changedContext.contextHash);
    expect(first.fixtureHash).not.toBe(changedContext.fixtureHash);
    expect(first.fixtureHash).toBe(changedAnswer.fixtureHash);
    expect(hashOolongSourceFixture(first)).not.toBe(hashOolongSourceFixture(changedAnswer));
    expect(first.goldAnswer).toBe("GOLD_SECRET");
    expect(first.manifest.contextHash).toBe(first.contextHash);
    expect(first.manifest.fixtureHash).toBe(first.fixtureHash);
    expect(first.manifest.contextChunks).toHaveLength(first.chunks.length);
    expect(JSON.stringify(first.manifest)).not.toContain('"answer"');
    expect(JSON.stringify(first.manifest)).not.toContain(first.goldAnswer);
  });
});

describe("official Oolong DnD scoring", () => {
  it("scores boxed integer answers with exponential absolute-error credit", () => {
    expect(scoreOolongDndResponse("5", String.raw`\boxed{5}`).score).toBe(1);
    expect(scoreOolongDndResponse("5", String.raw`\boxed{3}`).score).toBeCloseTo(0.75 ** 2);
    expect(scoreOolongDndResponse("5", "5")).toMatchObject({
      score: 0,
      attemptedParse: "5",
      parseConfidence: "low",
    });
  });

  it("scores strings case-insensitively and trims surrounding whitespace", () => {
    expect(scoreOolongDndResponse("Fireball", "  fireBALL  ").score).toBe(1);
    expect(scoreOolongDndResponse("Fireball", "Magic Missile").score).toBe(0);
  });

  it("scores boxed comma-list overlap against the gold-set size", () => {
    expect(
      scoreOolongDndResponse("Alice, Bob, Carol", String.raw`\boxed{Alice, Carol, Dave}`).score,
    ).toBeCloseTo(2 / 3);
    expect(scoreOolongDndResponse("Alice, Alice, Bob", String.raw`\boxed{Alice, Bob}`).score).toBe(
      1,
    );
    expect(scoreOolongDndResponse("Alice, Bob", String.raw`\boxed{alice, Bob}`).score).toBe(0.5);
    expect(scoreOolongDndResponse("Alice, Bob", "Alice, Bob").score).toBe(0);
  });

  it("parses boxed text answers using the official response forms", () => {
    expect(scoreOolongDndResponse("Fireball", String.raw`\boxed{\text{fireball}}`)).toMatchObject({
      score: 1,
      attemptedParse: "fireball",
      parseConfidence: "high",
    });
    expect(scoreOolongDndResponse("Alice, Bob", String.raw`\boxed{{Alice, Bob}}`).score).toBe(1);
  });
});
