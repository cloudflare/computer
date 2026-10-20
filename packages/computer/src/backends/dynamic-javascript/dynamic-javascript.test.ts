import { DynamicJavaScriptBackend, type DynamicJavaScriptFacets } from "./dynamic-javascript.js";

// DurableObjectClass is an empty interface, so a plain object fills it.
const loader = {
  load: () => ({ getEntrypoint: () => ({}), getDurableObjectClass: () => ({}) }),
};
const facets: DynamicJavaScriptFacets = {
  get: () => ({}),
  abort: () => undefined,
  delete: () => undefined,
  clone: () => undefined,
};

describe("DynamicJavaScriptBackend", () => {
  it("defaults its id and type to dynamic-javascript", () => {
    const backend = new DynamicJavaScriptBackend({ loader, facets });
    expect(backend.id).toBe("dynamic-javascript");
    expect(backend.type).toBe("dynamic-javascript");
    expect(backend.callable).toBe(true);
  });

  it("needs the host Durable Object's facets", () => {
    expect(
      () =>
        // SAFETY: The test leaves out a required option on purpose.
        new DynamicJavaScriptBackend({ loader } as never),
    ).toThrow(/needs facets/);
  });

  it("names itself in option errors", () => {
    expect(
      () => new DynamicJavaScriptBackend({ loader, facets, defaultTimeoutMs: 2, maxTimeoutMs: 1 }),
    ).toThrow("DynamicJavaScriptBackend defaultTimeoutMs cannot exceed maxTimeoutMs.");
  });

  it("describes apps beside its modules", () => {
    const backend = new DynamicJavaScriptBackend({
      loader,
      facets,
      modules: { "ws:weather": { forecast: () => "sun" } },
    });
    expect(backend.description).toContain("extends `DurableObject` from `cloudflare:workers`");
    expect(backend.description).toContain(
      "gives `ctx.facets` for that app, a `DurableObjectFacets`",
    );
    expect(backend.description).toContain("`Counter.clone(source, destination)`");
    expect(backend.description).toContain("- `ws:weather`: exports `forecast`.");
    expect(backend.description).toContain("Code has no direct network access.");
  });
});
