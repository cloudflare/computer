import { describe, expect, it } from "vitest";

import { BROWSER_USAGE, browserEntryModule, parseBrowserCommand, resolveTaskPath } from "./cli.js";

function run(argv: string[]) {
  const request = parseBrowserCommand(argv);
  if (request.kind !== "run") throw new Error(`expected a run request, got ${request.kind}`);
  return request;
}

function failure(argv: string[]) {
  const request = parseBrowserCommand(argv);
  if (request.kind !== "error") throw new Error(`expected an error request, got ${request.kind}`);
  return request.message;
}

describe("parseBrowserCommand", () => {
  it("reads a script path and target URL", () => {
    const request = run(["puppeteer", "--url", "https://example.com/", "run.js"]);

    expect(request.script).toBe("run.js");
    expect(request.url).toBe("https://example.com/");
    expect(request.stdin).toBe(false);
  });

  it("accepts flags joined with an equals sign", () => {
    expect(run(["puppeteer", "--url=https://example.com/", "run.js"]).url).toBe(
      "https://example.com/",
    );
  });

  it("reads the task from stdin", () => {
    const request = run(["puppeteer", "--url", "https://example.com/", "--stdin"]);

    expect(request.stdin).toBe(true);
    expect(request.script).toBeUndefined();
  });

  it("parses a timeout in milliseconds", () => {
    expect(run(["puppeteer", "--timeout", "45000", "run.js"]).timeoutMs).toBe(45_000);
  });

  it("parses structured task input", () => {
    expect(run(["puppeteer", "--input", '{"depth":2}', "run.js"]).input).toEqual({ depth: 2 });
  });

  it("requests help for --help", () => {
    expect(parseBrowserCommand(["--help"]).kind).toBe("help");
    expect(parseBrowserCommand(["puppeteer", "--help"]).kind).toBe("help");
  });

  it("requires an engine", () => {
    expect(failure([])).toContain("usage");
  });

  it("rejects an unknown engine", () => {
    expect(failure(["chrome", "run.js"])).toContain("unknown engine");
  });

  it("requires a script path or --stdin", () => {
    expect(failure(["puppeteer", "--url", "https://example.com/"])).toContain("--stdin");
  });

  it("rejects a script path together with --stdin", () => {
    expect(failure(["puppeteer", "--stdin", "run.js"])).toContain("not both");
  });

  it("rejects a second script path", () => {
    expect(failure(["puppeteer", "one.js", "two.js"])).toContain("one script");
  });

  it("rejects a URL that is not HTTP or HTTPS", () => {
    expect(failure(["puppeteer", "--url", "file:///etc/passwd", "run.js"])).toContain("http");
  });

  it("rejects a malformed URL", () => {
    expect(failure(["puppeteer", "--url", "example.com", "run.js"])).toContain("http");
  });

  it("rejects a timeout that is not a positive integer", () => {
    expect(failure(["puppeteer", "--timeout", "0", "run.js"])).toContain("timeout");
    expect(failure(["puppeteer", "--timeout", "later", "run.js"])).toContain("timeout");
  });

  it("rejects input that is not a JSON object", () => {
    expect(failure(["puppeteer", "--input", "[1]", "run.js"])).toContain("JSON object");
    expect(failure(["puppeteer", "--input", "{", "run.js"])).toContain("JSON object");
  });

  it("rejects a flag without a value", () => {
    expect(failure(["puppeteer", "--url"])).toContain("--url");
  });

  it("rejects an unknown flag", () => {
    expect(failure(["puppeteer", "--headless", "run.js"])).toContain("--headless");
  });

  it("documents the engine subcommand in its usage", () => {
    expect(BROWSER_USAGE).toContain("browser puppeteer");
  });
});

describe("resolveTaskPath", () => {
  it("resolves a relative path against the working directory", () => {
    expect(resolveTaskPath("/workspace/tasks", "run.js")).toEqual({
      path: "/workspace/tasks/run.js",
      cwd: "/workspace/tasks",
      specifier: "./run.js",
    });
  });

  it("keeps an absolute path", () => {
    expect(resolveTaskPath("/workspace", "/workspace/tasks/run.js").path).toBe(
      "/workspace/tasks/run.js",
    );
  });

  it("collapses dot segments", () => {
    expect(resolveTaskPath("/workspace/tasks", "../shared/./run.js")).toEqual({
      path: "/workspace/shared/run.js",
      cwd: "/workspace/shared",
      specifier: "./run.js",
    });
  });

  it("runs the task from its own directory", () => {
    expect(resolveTaskPath("/workspace", "tasks/deep/run.js").cwd).toBe("/workspace/tasks/deep");
  });
});

describe("browserEntryModule", () => {
  it("wraps the task module in a managed browser session", () => {
    const source = browserEntryModule("./run.js");

    expect(source).toContain('import task from "./run.js";');
    expect(source).toContain('import { withBrowser } from "@cloudflare/puppeteer";');
    expect(source).toContain("withBrowser(");
    expect(source).toContain("browser");
  });

  it("reports a task module that does not export a function", () => {
    expect(browserEntryModule("./run.js")).toContain("default function");
  });

  it("launches without guardrails when no host is known", () => {
    expect(browserEntryModule("./run.js")).not.toContain("allowedDomains");
  });

  it("confines the session to the requested host, its subdomains, and common CDNs", () => {
    const source = browserEntryModule("./run.js", "example.com");

    expect(source).toContain('"example.com"');
    expect(source).toContain('"*.example.com"');
    expect(source).toContain('"common-cdns"');
    expect(source).toContain("withBrowser(");
  });
});
