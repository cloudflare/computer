import assert from "node:assert/strict";
import test from "node:test";

import { reorderReleaseLine } from "./changelog-format.mjs";

const pull = "[#108](https://github.com/cloudflare/computer/pull/108)";
const commit = "[`3074d90`](https://github.com/cloudflare/computer/commit/3074d90aaa)";
const user = "[@aron-cf](https://github.com/aron-cf)";

test("puts the description first and the origin last", () => {
  const line = `\n\n- ${pull} ${commit} Thanks ${user}! - Serve both endpoints.\n`;
  assert.equal(
    reorderReleaseLine(line),
    `\n\n- ${pull} Serve both endpoints. (${commit}) - Thanks ${user}\n`,
  );
});

test("keeps the entry readable when no pull request was resolved", () => {
  const line = `\n\n- ${commit} Thanks ${user}! - Serve both endpoints.\n`;
  assert.equal(
    reorderReleaseLine(line),
    `\n\n- Serve both endpoints. (${commit}) - Thanks ${user}\n`,
  );
});

test("omits the author when none was resolved", () => {
  const line = `\n\n- ${pull} ${commit} - Serve both endpoints.\n`;
  assert.equal(reorderReleaseLine(line), `\n\n- ${pull} Serve both endpoints. (${commit})\n`);
});

test("leaves a bare description untouched", () => {
  const line = "\n\n- Serve both endpoints.\n";
  assert.equal(reorderReleaseLine(line), line);
});

test("preserves the indented continuation lines of a multi-line summary", () => {
  const line = `\n\n- ${pull} ${commit} Thanks ${user}! - First line.\n  Second line.\n  Third line.`;
  assert.equal(
    reorderReleaseLine(line),
    `\n\n- ${pull} First line. (${commit}) - Thanks ${user}\n  Second line.\n  Third line.`,
  );
});

test("keeps a description that itself contains a hyphen separator", () => {
  const line = `\n\n- ${pull} ${commit} Thanks ${user}! - Rename a - b to a-b.\n`;
  assert.equal(
    reorderReleaseLine(line),
    `\n\n- ${pull} Rename a - b to a-b. (${commit}) - Thanks ${user}\n`,
  );
});

test("handles multiple thanked authors", () => {
  const second = "[@other](https://github.com/other)";
  const line = `\n\n- ${pull} ${commit} Thanks ${user}, ${second}! - Serve both endpoints.\n`;
  assert.equal(
    reorderReleaseLine(line),
    `\n\n- ${pull} Serve both endpoints. (${commit}) - Thanks ${user}, ${second}\n`,
  );
});
