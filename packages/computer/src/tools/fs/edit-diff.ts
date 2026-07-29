/**
 * Pure text-manipulation primitives for the edit tool. No filesystem I/O lives
 * here — that's deliberate so this module stays trivially testable. Adapted
 * from earendil-works/pi (packages/coding-agent/src/core/tools/edit-diff.ts)
 * with the fs/promises preview path removed.
 */

import * as Diff from "diff";

// ---------- line endings & BOM ----------

export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

// ---------- fuzzy matching ----------

/**
 * Progressive normalization for fuzzy matching:
 *   - NFKC unicode normalization
 *   - strip trailing whitespace per line
 *   - smart quotes → ASCII
 *   - assorted unicode dashes → "-"
 *   - non-breaking / typographic spaces → " "
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  /** The content the caller should treat as the base for replacement. */
  contentForReplacement: string;
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }
  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

// ---------- edit application ----------

export interface Edit {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function notFound(path: string, idx: number, total: number): Error {
  if (total === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${idx}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}
function duplicate(path: string, idx: number, total: number, n: number): Error {
  if (total === 1) {
    return new Error(
      `Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${n} occurrences of edits[${idx}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}
function emptyOldText(path: string, idx: number, total: number): Error {
  if (total === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${idx}].oldText must not be empty in ${path}.`);
}
function noChange(path: string, total: number): Error {
  if (total === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more edits to LF-normalized content. All edits are matched
 * against the original content; replacements are then applied right-to-left
 * so earlier offsets stay valid.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalized = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
  }));

  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i].oldText.length === 0) throw emptyOldText(path, i, normalized.length);
  }

  // If any edit needs fuzzy matching, do all replacement in fuzzy-normalized
  // space so indices line up. Otherwise stay in the caller's exact content.
  const initial = normalized.map((e) => fuzzyFindText(normalizedContent, e.oldText));
  const baseContent = initial.some((m) => m.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matched: MatchedEdit[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    const m = fuzzyFindText(baseContent, e.oldText);
    if (!m.found) throw notFound(path, i, normalized.length);
    const occurrences = countOccurrences(baseContent, e.oldText);
    if (occurrences > 1) throw duplicate(path, i, normalized.length, occurrences);
    matched.push({
      editIndex: i,
      matchIndex: m.index,
      matchLength: m.matchLength,
      newText: e.newText,
    });
  }

  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const prev = matched[i - 1];
    const cur = matched[i];
    if (prev.matchIndex + prev.matchLength > cur.matchIndex) {
      throw new Error(
        `edits[${prev.editIndex}] and edits[${cur.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    newContent =
      newContent.substring(0, m.matchIndex) +
      m.newText +
      newContent.substring(m.matchIndex + m.matchLength);
  }

  if (baseContent === newContent) throw noChange(path, normalized.length);
  return { baseContent, newContent };
}

// ---------- diffs ----------

export function generateUnifiedPatch(
  path: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: contextLines,
  });
}

export interface EditDiffResult {
  diff: string;
  firstChangedLine: number | undefined;
}

/** Display-oriented diff with line numbers and bounded context. */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): EditDiffResult {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const w = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) firstChangedLine = newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(w, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(w, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
    } else {
      const nextIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
      const leading = lastWasChange;
      const trailing = nextIsChange;

      const emit = (line: string) => {
        output.push(` ${String(oldLineNum).padStart(w, " ")} ${line}`);
        oldLineNum++;
        newLineNum++;
      };

      if (leading && trailing) {
        if (raw.length <= contextLines * 2) {
          raw.forEach(emit);
        } else {
          raw.slice(0, contextLines).forEach(emit);
          const skipped = raw.length - contextLines * 2;
          output.push(` ${"".padStart(w, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
          raw.slice(raw.length - contextLines).forEach(emit);
        }
      } else if (leading) {
        raw.slice(0, contextLines).forEach(emit);
        const skipped = raw.length - contextLines;
        if (skipped > 0) {
          output.push(` ${"".padStart(w, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
      } else if (trailing) {
        const skipped = Math.max(0, raw.length - contextLines);
        if (skipped > 0) {
          output.push(` ${"".padStart(w, " ")} ...`);
          oldLineNum += skipped;
          newLineNum += skipped;
        }
        raw.slice(skipped).forEach(emit);
      } else {
        oldLineNum += raw.length;
        newLineNum += raw.length;
      }
      lastWasChange = false;
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}
