import { describe, expect, it } from "vitest";

import { buildModuleCatalog } from "./introspection.js";

describe("buildModuleCatalog", () => {
  const catalog = buildModuleCatalog("Modules.", [
    {
      _tag: "host",
      specifier: "ws:weather",
      summary: "the weather.",
      exports: ["forecast", "alerts", "raw"],
      types: {
        Place: "interface Place { city: string }",
        Forecast: "interface Forecast { place: Place; high: number }",
        Unused: "interface Unused { x: number }",
        forecast: "/** The forecast. */\nfunction forecast(place: Place): Promise<Forecast>;",
        alerts: "function alerts(): Promise<string[]>;",
      },
      examples: ['await forecast({ city: "Lisbon" });'],
    },
  ]);
  const weather = catalog.modules["ws:weather"];

  it("puts the types an export names, and the ones they name, before its declaration", () => {
    expect(weather?.exports.forecast?.types).toBe(
      [
        "interface Place { city: string }",
        "interface Forecast { place: Place; high: number }",
        "/** The forecast. */\nfunction forecast(place: Place): Promise<Forecast>;",
      ].join("\n\n"),
    );
    expect(weather?.exports.alerts?.types).toBe("function alerts(): Promise<string[]>;");
  });

  it("prints an export with its body named for where it runs", () => {
    expect(weather?.exports.alerts?.display).toBe(
      "function alerts(): Promise<string[]> { [host code] }",
    );
  });

  it("declares an export with no declaration as taking and returning unknown", () => {
    expect(weather?.exports.raw?.types).toBe("function raw(...args: unknown[]): Promise<unknown>;");
    expect(weather?.docs).toContain(
      "No declarations were given for `raw`, so it is shown taking and returning `unknown`.",
    );
  });

  it("declares the whole module, with the other types first and the exports in order", () => {
    const types = weather?.types ?? "";
    expect(types.startsWith('declare module "ws:weather" {\n  interface Place')).toBe(true);
    expect(types).toContain("  interface Unused { x: number }");
    expect(types.indexOf("function forecast")).toBeLessThan(types.indexOf("function alerts"));
    expect(types.indexOf("function alerts")).toBeLessThan(types.indexOf("function raw"));
    expect(types.endsWith("\n}")).toBe(true);
  });

  it("documents a module with its summary, declarations, and examples", () => {
    expect(weather?.docs).toMatch(
      /^# ws:weather\n\nThe weather\.\n\n```ts\ndeclare module "ws:weather" \{[\s\S]*\n```\n\n/,
    );
    expect(weather?.docs).toContain('Examples:\n\n```js\nawait forecast({ city: "Lisbon" });\n```');
  });

  it("keeps the overview as given", () => {
    expect(catalog.overview).toBe("Modules.");
  });
});
