// Tests for the session-scoping helpers. These are pure string
// functions; the suite pins the round-trip, the validation
// boundaries, and the foreign-name filtering `list` relies on.

import { describe, expect, it } from "vitest";

import { InvalidRepoNameError, InvalidSessionIdError } from "./errors.js";
import {
  assertLocalName,
  assertSessionId,
  scopedName,
  scopePrefix,
  unscopedName,
} from "./scope.js";

describe("scopedName", () => {
  it("joins session id and local name with a legal double-underscore separator", () => {
    expect(scopedName("sess1", "starter")).toBe("sess1__starter");
  });

  it("rejects an empty session id", () => {
    expect(() => scopedName("", "starter")).toThrow(InvalidSessionIdError);
  });

  it("rejects a session id containing the scope separator", () => {
    expect(() => scopedName("a__b", "starter")).toThrow(InvalidSessionIdError);
  });

  it("rejects a session id containing characters the binding rejects", () => {
    expect(() => scopedName("a/b", "starter")).toThrow(InvalidSessionIdError);
    expect(() => scopedName("-bad", "starter")).toThrow(InvalidSessionIdError);
  });

  it("rejects an empty local name", () => {
    expect(() => scopedName("sess1", "")).toThrow(InvalidRepoNameError);
  });

  it("rejects a local name containing the scope separator", () => {
    expect(() => scopedName("sess1", "a__b")).toThrow(InvalidRepoNameError);
  });

  it("rejects a local name containing characters the binding rejects", () => {
    expect(() => scopedName("sess1", "a/b")).toThrow(InvalidRepoNameError);
    expect(() => scopedName("sess1", ".")).toThrow(InvalidRepoNameError);
  });
});

describe("unscopedName", () => {
  it("strips the session prefix and returns the local name", () => {
    expect(unscopedName("sess1", "sess1__starter")).toBe("starter");
  });

  it("round-trips with scopedName", () => {
    expect(unscopedName("sess1", scopedName("sess1", "starter"))).toBe("starter");
  });

  it("returns undefined for a name in a different session", () => {
    expect(unscopedName("sess1", "sess2__starter")).toBeUndefined();
  });

  it("does not confuse prefix-related sessions", () => {
    expect(unscopedName("sess1", "sess10__starter")).toBeUndefined();
  });

  it("returns undefined for an unscoped name", () => {
    expect(unscopedName("sess1", "starter")).toBeUndefined();
  });

  it("returns undefined for a name with a nested separator", () => {
    // `sess1__a__b` can't have been minted by scopedName (which
    // forbids `__` in the local part), so it's treated as foreign.
    expect(unscopedName("sess1", "sess1__a__b")).toBeUndefined();
  });

  it("returns undefined for the bare prefix with no local part", () => {
    expect(unscopedName("sess1", "sess1__")).toBeUndefined();
  });
});

describe("scopePrefix", () => {
  it("is the session id followed by the scope separator", () => {
    expect(scopePrefix("sess1")).toBe("sess1__");
  });
});

describe("assertSessionId / assertLocalName", () => {
  it("return the value unchanged when valid", () => {
    expect(assertSessionId("sess1")).toBe("sess1");
    expect(assertLocalName("starter")).toBe("starter");
  });
});
