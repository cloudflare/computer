import { describe, expect, it } from "vitest";

import { UI_HTML } from "./ui.js";

describe("browser rendering UI", () => {
  it("starts with the Cloudflare Agents documentation", () => {
    expect(UI_HTML).toContain('value="https://developers.cloudflare.com/agents/"');
  });

  it("offers exactly the two invocation paths", () => {
    expect(UI_HTML).toContain('data-path="javascript"');
    expect(UI_HTML).toContain('data-path="shell"');
    for (const removed of ["scrape", "screenshot", "page-info", "research"]) {
      expect(UI_HTML).not.toContain(`data-action="${removed}"`);
    }
  });

  it("separates the integration from the example application", () => {
    expect(UI_HTML).toContain("Plugin setup");
    expect(UI_HTML).toContain("plugins: [puppeteer({ browser: env.BROWSER })]");
    expect(UI_HTML).toContain("commands: [browser]");
    expect(UI_HTML).toContain('import { withBrowser } from "@cloudflare/puppeteer"');
    expect(UI_HTML).toContain("browser puppeteer --url https://example.com/ report.js");
    expect(UI_HTML).toContain("The task module, the report format, and this interface are");
  });

  it("shows the durable artifacts both paths write", () => {
    expect(UI_HTML).toContain("@phosphor-icons/web@2.1.2");
    expect(UI_HTML).toContain('id="research-result"');
    expect(UI_HTML).toContain('id="workspace-tree"');
    expect(UI_HTML).toContain('id="artifacts"');
    expect(UI_HTML).toContain('id="screenshot-result"');
  });

  it("reports which path produced a result and how it was invoked", () => {
    expect(UI_HTML).toContain('id="invocation"');
    expect(UI_HTML).toContain("invocation.textContent = payload.invocation;");
  });

  it("renders an in-flight response against the submitted path", () => {
    expect(UI_HTML).toContain("const submittedPath = path;");
    expect(UI_HTML).toContain("JSON.stringify({ path: submittedPath, url: target })");
    expect(UI_HTML).toContain("renderValue({ ...payload, path: submittedPath })");
  });

  it("drops the removed per-action renderers", () => {
    for (const removed of ["renderScrape", "renderPageInfo", "addMetric", "showOnly("]) {
      expect(UI_HTML).not.toContain(removed);
    }
  });

  it("ships syntactically valid client JavaScript", () => {
    const script = UI_HTML.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script ?? "")).not.toThrow();
  });
});
