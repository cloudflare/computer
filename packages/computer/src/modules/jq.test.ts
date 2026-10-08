import { describe, expect, it } from "vitest";

import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../runtime/types.js";
import { createJqModule } from "./jq.js";

function build() {
  // SAFETY: The module uses nothing from the host.
  const query = createJqModule()({} as WorkspaceModuleHost).query;
  if (!query) throw new Error("ws:jq must export query");
  return query;
}

function callContext(signal = new AbortController().signal): WorkspaceModuleCallContext {
  return {
    signal,
    deadline: Date.now() + 60_000,
    access: "read",
    resolvePath: async (path) => path,
  };
}

describe("createJqModule", () => {
  it("runs a filter over a value", async () => {
    const query = build();

    await expect(
      query([{ items: [{ n: 1 }, { n: 2 }] }, "[.items[].n]", { compact: true }], callContext()),
    ).resolves.toBe("[1,2]\n");
  });

  it("takes JSON text as input", async () => {
    const query = build();

    await expect(query(['{"name":"a"}', ".name", { raw: true }], callContext())).resolves.toBe(
      "a\n",
    );
  });

  it("supports slurp, sort, and nullInput", async () => {
    const query = build();

    await expect(query(["1 2 3", "add", { slurp: true }], callContext())).resolves.toBe("6\n");
    await expect(
      query([{ b: 1, a: 2 }, ".", { sort: true, compact: true }], callContext()),
    ).resolves.toBe('{"a":2,"b":1}\n');
    await expect(
      query([null, "[range(3)]", { nullInput: true, compact: true }], callContext()),
    ).resolves.toBe("[0,1,2]\n");
  });

  it("keeps a filter with quotes as one program", async () => {
    const query = build();

    await expect(
      query([{ "it's": 1 }, `.["it's"] | "\\(.); ls"`, { raw: true }], callContext()),
    ).resolves.toBe("1; ls\n");
  });

  it("reports a jq error", async () => {
    const query = build();

    await expect(query([{}, ".[", {}], callContext())).rejects.toThrow();
  });

  it.each([
    [[{}], /takes an input, a filter/],
    [[{}, ""], /non-empty string/],
    [[{}, ".", "raw"], /options must be an object/],
    [[{}, ".", { pretty: true }], /unknown option "pretty"/],
    [[{}, ".", { raw: "yes" }], /must be a boolean/],
  ])("rejects %j", async (args, message) => {
    const query = build();

    await expect(query(args as never, callContext())).rejects.toThrow(message);
  });

  it("does not run once the call is cancelled", async () => {
    const query = build();
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(query([{}, "."], callContext(abort.signal))).rejects.toThrow("cancelled");
  });

  it("describes itself", () => {
    expect(createJqModule().description).toContain("query(input, filter");
  });
});
