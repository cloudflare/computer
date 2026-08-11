import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent, fuzzyFindText } from "./edit-diff.js";

const path = "/workspace/notes.md";

describe("fuzzy edit source mapping", () => {
  it("preserves every byte outside the fuzzy-matched span", () => {
    const original =
      "The spec says “must” — not optional.  \n" +
      "ligature: ﬁle; fraction: ½; space: a b\n" +
      "let target = 1;\n";

    expect(
      applyEditsToNormalizedContent(
        original,
        [{ oldText: "let target = 1; ", newText: "let target = 2;" }],
        path,
      ),
    ).toEqual({
      baseContent: original,
      newContent: original.replace("let target = 1;", "let target = 2;"),
    });
  });

  it("mixes exact and fuzzy edits in original-content coordinates", () => {
    const original = "keep “this” — unchanged  \nconst exact = 1;\nconst fuzzy = 2;\n";

    expect(
      applyEditsToNormalizedContent(
        original,
        [
          { oldText: "const exact = 1;", newText: "const exact = 3;" },
          { oldText: "const fuzzy = 2;", newText: "const fuzzy = 4;" },
        ],
        path,
      ).newContent,
    ).toBe("keep “this” — unchanged  \nconst exact = 3;\nconst fuzzy = 4;\n");
  });

  it("maps a complete NFKC expansion back to its source character", () => {
    expect(
      applyEditsToNormalizedContent(
        "const value = ﬁ;\n",
        [{ oldText: "fi", newText: "pair" }],
        path,
      ).newContent,
    ).toBe("const value = pair;\n");
  });

  it("maps a complete combining sequence and preserves supplementary characters", () => {
    const original = "const café = 1; // 🙂\n";

    expect(
      applyEditsToNormalizedContent(
        original,
        [{ oldText: "const café = 1;", newText: "const cafe = 2;" }],
        path,
      ).newContent,
    ).toBe("const cafe = 2; // 🙂\n");
  });

  it("rejects a match that ends inside an NFKC expansion", () => {
    expect(() =>
      applyEditsToNormalizedContent("const value = ﬁ;\n", [{ oldText: "f", newText: "x" }], path),
    ).toThrow(/ambiguous Unicode-normalization or trimmed-whitespace boundary/);
  });

  it("rejects a fuzzy edit when normalization makes multiple matches ambiguous", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "const value = 1;\nconst value = 1;\n",
        [{ oldText: "const value = 1; ", newText: "updated" }],
        path,
      ),
    ).toThrow(/Found 2 occurrences/);
  });

  it("uses a later safe match when an earlier normalized occurrence has an unsafe boundary", () => {
    expect(
      applyEditsToNormalizedContent("ﬁ\nf\n", [{ oldText: "f", newText: "x" }], path).newContent,
    ).toBe("ﬁ\nx\n");
  });

  it("rejects a match that starts inside an NFKC expansion", () => {
    expect(() =>
      applyEditsToNormalizedContent("const value = ﬁ;\n", [{ oldText: "i", newText: "x" }], path),
    ).toThrow(/ambiguous Unicode-normalization or trimmed-whitespace boundary/);
  });

  it("preserves trailing whitespace adjacent to a fuzzy span", () => {
    expect(
      applyEditsToNormalizedContent(
        "const value = 1;  ",
        [{ oldText: "const value = 1;", newText: "const value = 2;" }],
        path,
      ).newContent,
    ).toBe("const value = 2;  ");
  });

  it("preserves trailing whitespace before a fuzzy span that starts with a newline", () => {
    expect(
      applyEditsToNormalizedContent(
        "header   \nfoo “x”;\n",
        [{ oldText: '\nfoo "x";', newText: '\nfoo "y";' }],
        path,
      ).newContent,
    ).toBe('header   \nfoo "y";\n');
  });

  it("does not treat an exact match as a fuzzy duplicate", () => {
    expect(
      applyEditsToNormalizedContent(
        "foo();  \nfoo();\n",
        [{ oldText: "foo();\n", newText: "bar();\n" }],
        path,
      ).newContent,
    ).toBe("foo();  \nbar();\n");
  });

  it("preserves trailing whitespace after a multiline fuzzy span", () => {
    expect(
      applyEditsToNormalizedContent(
        "first line\nsecond line  \nafter  \n",
        [{ oldText: "first line\nsecond line", newText: "combined" }],
        path,
      ).newContent,
    ).toBe("combined  \nafter  \n");
  });

  it("replaces a fuzzy match that ends at EOF after an earlier trimmed line", () => {
    expect(
      applyEditsToNormalizedContent(
        "keep trailing spaces   \ntarget value",
        [{ oldText: "target value", newText: "updated" }],
        path,
      ).newContent,
    ).toBe("keep trailing spaces   \nupdated");
  });

  it("rejects a fuzzy edit when grapheme-local NFKC differs from whole-string NFKC", () => {
    expect(() =>
      applyEditsToNormalizedContent(
        "ㄱᅡ value\n",
        [{ oldText: "가 value", newText: "updated" }],
        path,
      ),
    ).toThrow(/ambiguous Unicode-normalization or trimmed-whitespace boundary/);
  });

  it("maps only candidate lines in a large file", () => {
    const untouchedLine = `${"x".repeat(256 * 1024)}ㄱᅡ unrelated`;
    const original = `${untouchedLine}\nconst value = ﬁ;\n`;

    expect(
      applyEditsToNormalizedContent(
        original,
        [{ oldText: "const value = fi;", newText: "const value = pair;" }],
        path,
      ).newContent,
    ).toBe(`${untouchedLine}\nconst value = pair;\n`);
  });

  it("replaces an entire grapheme even when whole-string NFKC composes it", () => {
    expect(
      applyEditsToNormalizedContent("Ångstrom\n", [{ oldText: "Å", newText: "A" }], path)
        .newContent,
    ).toBe("Angstrom\n");
  });

  it("maps fuzzy matches after supplementary characters", () => {
    const content = "🙂 before; const value = 1; after\n";
    const match = fuzzyFindText(content, "const value = 1;");

    expect(match).toMatchObject({
      found: true,
      index: content.indexOf("const value"),
      matchLength: "const value = 1;".length,
      usedFuzzyMatch: true,
    });
  });
});
