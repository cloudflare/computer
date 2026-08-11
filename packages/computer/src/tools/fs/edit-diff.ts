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

function foldFuzzyCharacters(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function normalizeNfkcForFuzzyMatch(text: string): string {
  return foldFuzzyCharacters(
    text
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
  );
}

/**
 * Progressive normalization for fuzzy matching:
 *   - NFKC unicode normalization
 *   - strip trailing whitespace per line
 *   - smart quotes → ASCII
 *   - assorted unicode dashes → "-"
 *   - non-breaking / typographic spaces → " "
 */
export function normalizeForFuzzyMatch(text: string): string {
  return normalizeNfkcForFuzzyMatch(text.normalize("NFKC"));
}

export interface FuzzyMatchResult {
  found: boolean;
  /** Offset in the original content, including for a fuzzy match. */
  index: number;
  /** Length in the original content, including for a fuzzy match. */
  matchLength: number;
  usedFuzzyMatch: boolean;
  /** The original content that replacements must be applied to. */
  contentForReplacement: string;
  /** The normalized match does not have safe boundaries in the original content. */
  unsafeBoundary?: boolean;
}

interface FuzzyContent {
  text: string;
  originalLines: string[];
  normalizedLines: string[];
  originalLineStarts: number[];
  lineMappings: Map<number, FuzzyLineMapping>;
}

interface FuzzyLineMapping {
  nfkcText: string;
  fuzzyText: string;
  boundaryColumns: Map<number, number | undefined>;
}

interface TextBoundary {
  lineIndex: number;
  column: number;
}

const fuzzyGraphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function prepareFuzzyContent(content: string): FuzzyContent {
  const text = normalizeForFuzzyMatch(content);
  const originalLines = content.split("\n");
  const normalizedLines = text.split("\n");
  const originalLineStarts: number[] = [];
  let originalLineStart = 0;
  for (const line of originalLines) {
    originalLineStarts.push(originalLineStart);
    originalLineStart += line.length + 1;
  }

  return {
    text,
    originalLines,
    normalizedLines,
    originalLineStarts,
    lineMappings: new Map(),
  };
}

function getTextBoundary(lines: string[], offset: number): TextBoundary | undefined {
  if (offset < 0) return undefined;

  let lineStart = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineEnd = lineStart + lines[lineIndex].length;
    if (offset <= lineEnd) return { lineIndex, column: offset - lineStart };
    lineStart = lineEnd + 1;
  }
  return undefined;
}

function isCodePointBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function getFuzzyLineMapping(
  content: FuzzyContent,
  lineIndex: number,
): FuzzyLineMapping | undefined {
  const cached = content.lineMappings.get(lineIndex);
  if (cached) return cached;

  const originalLine = content.originalLines[lineIndex];
  if (originalLine === undefined) return undefined;
  const nfkcText = originalLine.normalize("NFKC");
  const mapping: FuzzyLineMapping = {
    nfkcText,
    fuzzyText: normalizeNfkcForFuzzyMatch(nfkcText),
    boundaryColumns: new Map(),
  };
  content.lineMappings.set(lineIndex, mapping);
  return mapping;
}

/** Map one normalized line column to an unambiguous original line column. */
function mapFuzzyLineBoundary(
  originalLine: string,
  mapping: FuzzyLineMapping,
  normalizedColumn: number,
): number | undefined {
  if (mapping.boundaryColumns.has(normalizedColumn)) {
    return mapping.boundaryColumns.get(normalizedColumn);
  }

  let originalColumn: number | undefined;
  // Character folding preserves UTF-16 length, so an NFKC-stable line needs no
  // grapheme source map. This is the common large-file path.
  if (mapping.nfkcText === originalLine) {
    originalColumn = normalizedColumn <= originalLine.length ? normalizedColumn : undefined;
  } else {
    let fuzzyColumn = 0;
    let nfkcColumn = 0;
    for (const segment of fuzzyGraphemeSegmenter.segment(originalLine)) {
      if (fuzzyColumn === normalizedColumn) {
        originalColumn = segment.index;
        break;
      }
      if (fuzzyColumn > normalizedColumn) break;

      const normalizedSegment = segment.segment.normalize("NFKC");
      // Whole-line NFKC is authoritative. Validate only the prefix needed for
      // this boundary instead of segmenting and allocating for the whole file.
      if (!mapping.nfkcText.startsWith(normalizedSegment, nfkcColumn)) break;
      nfkcColumn += normalizedSegment.length;
      fuzzyColumn += foldFuzzyCharacters(normalizedSegment).length;
    }
    if (
      originalColumn === undefined &&
      fuzzyColumn === normalizedColumn &&
      nfkcColumn === mapping.nfkcText.length
    ) {
      originalColumn = originalLine.length;
    }
  }

  mapping.boundaryColumns.set(normalizedColumn, originalColumn);
  return originalColumn;
}

/** Map one fuzzy-text boundary back to an unambiguous original-text boundary. */
function mapFuzzyBoundary(
  content: FuzzyContent,
  normalizedOffset: number,
  kind: "start" | "end",
): number | undefined {
  if (content.originalLines.length !== content.normalizedLines.length) return undefined;
  const boundary = getTextBoundary(content.normalizedLines, normalizedOffset);
  if (!boundary) return undefined;

  const originalLine = content.originalLines[boundary.lineIndex];
  const normalizedLine = content.normalizedLines[boundary.lineIndex];
  const originalLineStart = content.originalLineStarts[boundary.lineIndex];
  const lineMapping = getFuzzyLineMapping(content, boundary.lineIndex);
  if (
    originalLine === undefined ||
    normalizedLine === undefined ||
    originalLineStart === undefined ||
    lineMapping === undefined ||
    !isCodePointBoundary(normalizedLine, boundary.column) ||
    lineMapping.fuzzyText !== normalizedLine
  ) {
    return undefined;
  }

  // A fuzzy boundary at line end sits on both sides of trimmed whitespace.
  // Starts belong after that whitespace; ends belong before it.
  if (kind === "start" && boundary.column === normalizedLine.length) {
    return originalLineStart + originalLine.length;
  }

  const originalColumn = mapFuzzyLineBoundary(originalLine, lineMapping, boundary.column);
  return originalColumn === undefined ? undefined : originalLineStart + originalColumn;
}

function findText(
  content: string,
  oldText: string,
  preparedContent?: FuzzyContent,
): FuzzyMatchResult {
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

  const fuzzyContent = preparedContent ?? prepareFuzzyContent(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      contentForReplacement: content,
      unsafeBoundary: true,
    };
  }

  let fuzzyIndex = fuzzyContent.text.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  // A normalized occurrence can land on an unsafe partial expansion while a
  // later occurrence maps cleanly. Uniqueness is checked separately, so locate
  // the first source-mappable occurrence here rather than failing early.
  let originalStart: number | undefined;
  let originalEnd: number | undefined;
  let normalizedSpan: string | undefined;
  while (fuzzyIndex !== -1) {
    originalStart = mapFuzzyBoundary(fuzzyContent, fuzzyIndex, "start");
    originalEnd = mapFuzzyBoundary(fuzzyContent, fuzzyIndex + fuzzyOldText.length, "end");
    normalizedSpan =
      originalStart === undefined || originalEnd === undefined
        ? undefined
        : normalizeForFuzzyMatch(content.slice(originalStart, originalEnd));
    if (normalizedSpan === fuzzyOldText) break;
    originalStart = undefined;
    originalEnd = undefined;
    normalizedSpan = undefined;
    fuzzyIndex = fuzzyContent.text.indexOf(fuzzyOldText, fuzzyIndex + 1);
  }
  const expectedSpan =
    originalStart === undefined || originalEnd === undefined
      ? undefined
      : fuzzyContent.text.slice(fuzzyIndex, fuzzyIndex + fuzzyOldText.length);
  if (
    originalStart === undefined ||
    originalEnd === undefined ||
    originalEnd < originalStart ||
    normalizedSpan !== expectedSpan ||
    normalizedSpan !== fuzzyOldText
  ) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: true,
      contentForReplacement: content,
      unsafeBoundary: true,
    };
  }

  return {
    found: true,
    index: originalStart,
    matchLength: originalEnd - originalStart,
    usedFuzzyMatch: true,
    contentForReplacement: content,
  };
}

export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  return findText(content, oldText);
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

function countOccurrences(
  content: string,
  oldText: string,
  fuzzyContent: string | undefined,
  usedFuzzyMatch: boolean,
): number {
  if (!usedFuzzyMatch) return content.split(oldText).length - 1;
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  if (fuzzyOldText.length === 0) return 0;
  return (fuzzyContent ?? normalizeForFuzzyMatch(content)).split(fuzzyOldText).length - 1;
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
function unsafeFuzzyBoundary(path: string, idx: number, total: number): Error {
  const target = total === 1 ? "The fuzzy match" : `The fuzzy match for edits[${idx}]`;
  return new Error(
    `${target} in ${path} crosses an ambiguous Unicode-normalization or trimmed-whitespace boundary. Copy the exact source text or use a span whose normalized boundaries map cleanly.`,
  );
}

/**
 * Apply one or more edits to LF-normalized content. All edits are matched
 * against the original content; replacements are then applied right-to-left
 * so earlier offsets stay valid. Fuzzy normalization is lookup-only: every
 * replacement is spliced into the original content.
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

  const needsFuzzyMapping = normalized.some((e) => !normalizedContent.includes(e.oldText));
  const fuzzyContent = needsFuzzyMapping ? prepareFuzzyContent(normalizedContent) : undefined;
  const matched: MatchedEdit[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    const m = findText(normalizedContent, e.oldText, fuzzyContent);
    if (m.unsafeBoundary) throw unsafeFuzzyBoundary(path, i, normalized.length);
    if (!m.found) throw notFound(path, i, normalized.length);
    const occurrences = countOccurrences(
      normalizedContent,
      e.oldText,
      fuzzyContent?.text,
      m.usedFuzzyMatch,
    );
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

  let newContent = normalizedContent;
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    newContent =
      newContent.substring(0, m.matchIndex) +
      m.newText +
      newContent.substring(m.matchIndex + m.matchLength);
  }

  if (normalizedContent === newContent) throw noChange(path, normalized.length);
  return { baseContent: normalizedContent, newContent };
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
