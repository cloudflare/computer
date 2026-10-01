import { describe, expect, it } from "vitest";

import {
  JAVASCRIPT_ENTRY,
  parseCommandResult,
  RUNS_DIRECTORY,
  shellCommand,
  shellQuote,
  TASK_PATH,
  TASK_SOURCE,
  TASK_TIMEOUT_MS,
} from "./execution-source.js";

describe("task module", () => {
  it("takes the browser from its caller instead of opening one", () => {
    expect(TASK_SOURCE).toContain("export default async function report({ url, browser })");
    expect(TASK_SOURCE).not.toContain("withBrowser");
  });

  it("writes all three artifacts into one run directory", () => {
    expect(TASK_SOURCE).toContain('import fs from "node:fs/promises"');
    expect(TASK_SOURCE).toContain(`"${RUNS_DIRECTORY}/" + crypto.randomUUID()`);
    for (const artifact of ["report.md", "page.json", "screenshot.png"]) {
      expect(TASK_SOURCE).toContain(artifact);
    }
  });

  it("is seeded where both paths look for it", () => {
    expect(TASK_PATH).toBe("/workspace/tasks/report.js");
  });
});

describe("JAVASCRIPT_ENTRY", () => {
  it("runs the seeded task inside a managed browser", () => {
    expect(JAVASCRIPT_ENTRY).toContain('import { withBrowser } from "@cloudflare/puppeteer"');
    expect(JAVASCRIPT_ENTRY).toContain('import report from "./report.js"');
    expect(JAVASCRIPT_ENTRY).toContain("withBrowser((browser) => report({ ...input, browser })");
  });

  it("confines the session the way the shell command does", () => {
    expect(JAVASCRIPT_ENTRY).toContain("allowedDomains");
    expect(JAVASCRIPT_ENTRY).toContain('"*." + input.hostname');
    expect(JAVASCRIPT_ENTRY).toContain("common-cdns");
  });
});

describe("shellCommand", () => {
  it("invokes the seeded task by name", () => {
    expect(shellCommand("https://example.com/")).toBe(
      `browser puppeteer --url 'https://example.com/' --timeout ${TASK_TIMEOUT_MS} report.js`,
    );
  });

  it("names the task relative to the directory it runs from", () => {
    expect(shellCommand("https://example.com/")).toContain(
      TASK_PATH.slice(TASK_PATH.lastIndexOf("/") + 1),
    );
    expect(shellCommand("https://example.com/")).not.toContain("/workspace");
  });

  it("keeps a quote in the URL from becoming shell syntax", () => {
    const command = shellCommand("https://example.com/?q='; rm -rf /");

    expect(command).toContain(`'https://example.com/?q='\\''; rm -rf /'`);
    expect(command.endsWith("report.js")).toBe(true);
  });
});

describe("parseCommandResult", () => {
  it("reads a result that is the whole output", () => {
    expect(parseCommandResult('{\n  "title": "Example"\n}\n')).toEqual({ title: "Example" });
  });

  it("reads the result printed after the task's own output", () => {
    const stdout = 'scraping...\ndone\n{\n  "title": "Example"\n}\n';

    expect(parseCommandResult(stdout)).toEqual({ title: "Example" });
  });

  it("reports output that carries no result", () => {
    expect(() => parseCommandResult("nothing to see\n")).toThrow("no JSON result");
  });
});

describe("shellQuote", () => {
  it("wraps a plain value", () => {
    expect(shellQuote("plain")).toBe("'plain'");
  });

  it("escapes every embedded quote", () => {
    expect(shellQuote("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  it("escapes a quote the URL parser leaves in the path", () => {
    // A quote in the query is percent-encoded by the URL parser, but one
    // in the path survives, so this is the shape that reaches the shell
    // intact. Unescaped, it closes the quoting and the rest of the URL
    // is parsed as commands.
    const href = new URL("https://example.com/a';id;'.html").href;

    expect(href).toContain("'");
    expect(shellQuote(href)).toBe(`'https://example.com/a'\\'';id;'\\''.html'`);
  });
});
