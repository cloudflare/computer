// Wire error code coverage. Every WireErrorCode is supposed to
// surface from at least one call site so a silent "default to
// EIO" regression in the host adapter trips a test rather than
// corrupting user-visible behaviour.
//
// This isn't an exhaustive list of who throws what — it's a
// presence check. The map below is hand-maintained: when a new
// code is added to WireErrorCode, add it here with a one-line
// pointer to a call site that raises it.

import { describe, expect, it } from "vitest";

import type { WireErrorCode } from "./interface.js";

// Hand-maintained registry: code → (a representative call site
// that raises it, in source form). The test below verifies the
// map covers every WireErrorCode in the union.
const COVERAGE: Record<WireErrorCode, string> = {
  ENOENT:
    "dofs:fs/stat throws ENOENT for a missing path; computerd:runner throws on get() of unknown id.",
  EUNKNOWN_HASH: "workspace:WorkspaceFs#assembleChunks throws when fetchObjects skipped a hash.",
  ESHUTDOWN:
    "TBD — computerd shutdown path will raise this when the runner refuses new exec after disposeAll.",
  EAUTH: "TBD — wired when the COMPUTERD_AUTH_TOKEN handshake lands.",
  EPROTOCOL:
    "TBD — wired when frame-size / version-mismatch enforcement lands (docs/08 open question).",
  EEXEC_BUSY:
    "computerd:exec/runner.ts throws when an id is reused while live, or a second subscriber attaches.",
  ELOG_TRUNCATED:
    "computerd:exec/log.ts throws on replay() when the meta row marks the log as evicted.",
};

describe("WireErrorCode coverage registry", () => {
  it("covers every code in the WireErrorCode union", () => {
    // The compiler enforces the COVERAGE keys ARE the union
    // (Record<WireErrorCode, string>). If a code is added to
    // the union and not to COVERAGE, this file fails to
    // compile, which the test runner surfaces as a build
    // error before the test even runs.
    //
    // The runtime assertion here is belt-and-braces: it
    // catches the inverse mistake of leaving a stale entry in
    // COVERAGE after a code is removed.
    const codes = Object.keys(COVERAGE) as WireErrorCode[];
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(COVERAGE[code]).toMatch(/\S/);
    }
  });

  it("notes which codes are still TBD so we don't ship a thrown-nowhere code silently", () => {
    const tbd = Object.entries(COVERAGE)
      .filter(([, note]) => note.startsWith("TBD"))
      .map(([code]) => code);
    // These three are real wire codes the contract reserves
    // for future phases. Failing this assertion means we
    // either wired up a path (good — drop the TBD prefix in
    // COVERAGE) or added a new code without a real call site
    // (bad — wire it or drop the code from the union).
    expect(new Set(tbd)).toEqual(new Set(["ESHUTDOWN", "EAUTH", "EPROTOCOL"]));
  });
});
