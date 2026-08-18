// Tests for the session-scoping helpers. These are pure string
// functions; the suite pins the round-trip, the validation
// boundaries, and the foreign-name filtering `list` relies on.

import { describe, expect, it } from "vitest";

import { InvalidRepoNameError, InvalidSessionIdError } from "./errors.js";
import {
  assertLocalName,
  assertRepoName,
  assertSessionId,
  normalizeSessionId,
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

describe("normalizeSessionId", () => {
  it("returns undefined when no session id is given", () => {
    expect(normalizeSessionId(undefined)).toBeUndefined();
    expect(normalizeSessionId(null)).toBeUndefined();
  });

  it("returns a valid session id unchanged", () => {
    expect(normalizeSessionId("sess1")).toBe("sess1");
  });

  it("rejects an empty session id rather than reading it as absent", () => {
    // An id that came out empty by accident (an unset template
    // variable, say) would otherwise widen the client to the whole
    // namespace in silence. Absence has to be spelled out.
    expect(() => normalizeSessionId("")).toThrow(InvalidSessionIdError);
  });

  it("rejects a malformed session id", () => {
    expect(() => normalizeSessionId("a__b")).toThrow(InvalidSessionIdError);
    expect(() => normalizeSessionId("a/b")).toThrow(InvalidSessionIdError);
  });
});

describe("scopedName without a session id", () => {
  it("passes a name through verbatim", () => {
    expect(scopedName(undefined, "starter")).toBe("starter");
  });

  it("accepts a name carrying another session's prefix", () => {
    // An unscoped client addresses every repository in the
    // namespace, including the ones a scoped session minted, so the
    // separator is an ordinary character here.
    expect(scopedName(undefined, "sess1__starter")).toBe("sess1__starter");
  });

  it("still rejects a name the binding itself would reject", () => {
    expect(() => scopedName(undefined, "")).toThrow(InvalidRepoNameError);
    expect(() => scopedName(undefined, "a/b")).toThrow(InvalidRepoNameError);
    expect(() => scopedName(undefined, "-bad")).toThrow(InvalidRepoNameError);
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

describe("unscopedName without a session id", () => {
  it("returns a bare name verbatim", () => {
    expect(unscopedName(undefined, "starter")).toBe("starter");
  });

  it("keeps a name belonging to a session instead of filtering it", () => {
    // This is what makes `list()` namespace-wide: nothing is foreign
    // to a client that has no session of its own.
    expect(unscopedName(undefined, "sess1__starter")).toBe("sess1__starter");
    expect(unscopedName(undefined, "sess1__a__b")).toBe("sess1__a__b");
  });
});

describe("scopePrefix", () => {
  it("is the session id followed by the scope separator", () => {
    expect(scopePrefix("sess1")).toBe("sess1__");
  });
});

describe("assertRepoName", () => {
  it("permits the scope separator a local name forbids", () => {
    expect(assertRepoName("sess1__starter")).toBe("sess1__starter");
    expect(() => assertLocalName("sess1__starter")).toThrow(InvalidRepoNameError);
  });

  it("rejects the characters the binding rejects", () => {
    expect(() => assertRepoName("")).toThrow(InvalidRepoNameError);
    expect(() => assertRepoName("a/b")).toThrow(InvalidRepoNameError);
    expect(() => assertRepoName("_leading")).toThrow(InvalidRepoNameError);
  });
});

describe("assertSessionId / assertLocalName", () => {
  it("return the value unchanged when valid", () => {
    expect(assertSessionId("sess1")).toBe("sess1");
    expect(assertLocalName("starter")).toBe("starter");
  });
});
