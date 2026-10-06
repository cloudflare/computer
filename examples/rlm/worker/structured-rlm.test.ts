import { describe, expect, it } from "vitest";

import type { OolongRealFixture } from "./benchmark";
import type { BenchmarkFixture } from "./fixture-types";
import { classifyRlmTask, structuredRlmSystemPrompt } from "./structured-rlm";

describe("structured RLM strategy", () => {
  it.each([
    ["singledoc_rolls", "Total number of rolls in this episode?", "roll_count"],
    [
      "singledoc_spells",
      "What is the first spell cast by each character in this episode?",
      "first_spell_by_character",
    ],
    ["singledoc_spells", "What is the least common spell in this episode?", "least_common_spell"],
    [
      "singledoc_spells",
      "Which spells were cast at a level higher than their base level?",
      "upcast_spells",
    ],
  ])("classifies %s questions", (questionType, question, expected) => {
    expect(classifyRlmTask(questionType, question)).toMatchObject({ kind: expected });
  });

  it("classifies Oolong-synth counting as semantic label frequency", () => {
    expect(
      classifyRlmTask("counting:TASK_TYPE.LEAST_FREQ", "Which of the labels is the least common?"),
    ).toMatchObject({ kind: "semantic_label_frequency" });
  });

  it("extracts a target character from multidocument questions", () => {
    expect(
      classifyRlmTask(
        "multidoc_spells",
        "List the last spell cast by the character Keyleth in each episode?",
      ),
    ).toMatchObject({ kind: "last_spell_by_episode", targetCharacter: "Keyleth" });
  });

  it.each([
    [
      "singledoc_rolls",
      "Total number of rolls in this episode?",
      'Return exactly {"rollCount":0}',
      "Sum rollCount",
    ],
    [
      "singledoc_spells",
      "What is the first spell cast by each character in this episode?",
      'Return exactly {"firstCasts"',
      "earliest position for each character",
    ],
    [
      "singledoc_spells",
      "What is the least common spell in this episode?",
      'Return exactly {"spellCounts"',
      "minimum positive total",
    ],
    [
      "singledoc_spells",
      "Which spells were cast at a level higher than their base level?",
      'Return exactly {"upcasts"',
      "castLevel > baseLevel",
    ],
    [
      "multidoc_spells",
      "List the last spell cast by the character Keyleth in each episode?",
      'Return exactly {"lastTargetCast"',
      "greatest position in each episode",
    ],
  ])(
    "gives %s tasks a compact child schema and deterministic reducer",
    (questionType, question, childSchema, reducer) => {
      const fixture = {
        manifest: { questionType, episodes: [27, 28], question },
        goldAnswer: "SECRET_GOLD",
      } as OolongRealFixture;
      const prompt = structuredRlmSystemPrompt(fixture);

      expect(prompt).toContain(childSchema);
      expect(prompt).toContain(reducer);
      expect(prompt).toContain("Ignore malformed child results");
      expect(prompt).not.toContain("SECRET_GOLD");
    },
  );

  it("tells generated synth modules to repeat the label rules and validate totals", () => {
    const fixture = {
      kind: "synth",
      manifest: {
        questionType: "counting:TASK_TYPE.LEAST_FREQ",
        question: "Which label is least common?",
      },
      goldAnswer: "SECRET_GOLD",
    } as BenchmarkFixture;
    const prompt = structuredRlmSystemPrompt(fixture);

    expect(prompt).toContain("input also includes preamble");
    expect(prompt).toContain('"labelCounts"');
    expect(prompt).toContain("records equal to the sum");
    expect(prompt).not.toContain("SECRET_GOLD");
  });

  it("uses public metadata without exposing the gold answer", () => {
    const fixture = {
      manifest: {
        questionType: "multidoc_spells",
        episodes: [27, 28],
        question: "List the last spell cast by the character Keyleth in each episode?",
      },
      goldAnswer: "SECRET_GOLD",
    } as OolongRealFixture;
    const prompt = structuredRlmSystemPrompt(fixture);

    expect(prompt).toContain("structured-v1");
    expect(prompt).toContain("last_spell_by_episode");
    expect(prompt).toContain("batch(requests)");
    expect(prompt).not.toContain("SECRET_GOLD");
  });
});
