import { describe, expect, test } from "vitest";
import { comparisonFixture } from "./fixture";

describe("comparisonFixture", () => {
  test("defines a docs feature task for both runtimes", () => {
    expect(comparisonFixture.root).toBe("/workspace/repo");
    expect(comparisonFixture.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "style-guide.md",
      "docs-nav.json",
      "feature-briefs/smart-request-policies.md",
      "docs/workers/index.md",
      "docs/workers/routing.md",
      "docs/workers/security.md",
      "docs/workers/examples/authenticated-api.md",
      "docs/workers/examples/rate-limit.md",
      "docs/_partials/beta-note.md",
      "scripts/check-docs.mjs",
    ]);
    expect(comparisonFixture.task).toContain("Add documentation for Smart Request Policies");
    expect(comparisonFixture.task).toContain("create a new Workers docs page");
    expect(comparisonFixture.task).toContain("update the docs navigation");
  });

  test("provides source material for a file-first docs workflow", () => {
    const brief = fileContents("feature-briefs/smart-request-policies.md");
    const styleGuide = fileContents("style-guide.md");
    const nav = fileContents("docs-nav.json");
    const checker = fileContents("scripts/check-docs.mjs");

    expect(brief).toContain("Smart Request Policies");
    expect(brief).toContain("Enterprise report exports");
    expect(styleGuide).toContain("Frontmatter");
    expect(styleGuide).toContain("Workers docs style");
    expect(nav).toContain("Workers");
    expect(checker).toContain("docs/workers/smart-request-policies.md");
    expect(checker).toContain("docs-nav.json");
  });

  test("reports all docs validation failures as repair instructions", () => {
    const files = createFixtureFiles();
    files.set(
      `${comparisonFixture.root}/docs/workers/smart-request-policies.md`,
      [
        "---",
        "title: Smart Request Policies",
        "description: Configure Smart Request Policies.",
        "lastUpdated: 2026-06-05",
        "---",
        "",
        "# Smart Request Policies",
        "",
        "This draft intentionally misses several validation requirements.",
        "",
        "~~~ts",
        "export default { async fetch() { return new Response('ok'); } };",
        "~~~",
        "",
      ].join("\n"),
    );

    const result = runDocsCheck(files);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("docs validation failed:");
    expect(result.output).toContain('exact header name "x-bypass-token"');
    expect(result.output).toContain('exact phrase "Enterprise report exports"');
    expect(result.output).toContain('path "/workers/smart-request-policies/"');
    expect(result.output).toContain('README.md must include "smart-request-policies"');
  });

  test("accepts docs that satisfy the validation contract", () => {
    const files = createFixtureFiles();
    files.set(
      `${comparisonFixture.root}/docs/workers/smart-request-policies.md`,
      [
        "---",
        "title: Smart Request Policies",
        "description: Configure Smart Request Policies for Workers requests.",
        "lastUpdated: 2026-06-05",
        "---",
        "",
        "# Smart Request Policies",
        "",
        "Smart Request Policies evaluate method, path, header, and risk-signal rules before a Worker handler runs.",
        "",
        "Enterprise report exports can use a route-specific bypass token for scheduled jobs.",
        "The Worker can check the `x-bypass-token` header before allowing sensitive export routes.",
        "",
        "~~~ts",
        "export default { async fetch(request: Request, env: Env): Promise<Response> {",
        "  const url = new URL(request.url);",
        "  if (url.pathname === '/reports/export' && request.method !== 'GET') {",
        "    if (request.headers.get('x-bypass-token') !== env.EXPORT_BYPASS_TOKEN) {",
        "      return new Response('Policy denied', { status: 403 });",
        "    }",
        "  }",
        "  return fetch(request);",
        "} };",
        "~~~",
        "",
      ].join("\n"),
    );
    files.set(
      `${comparisonFixture.root}/docs-nav.json`,
      JSON.stringify(
        {
          sections: [
            {
              title: "Workers",
              items: [
                { title: "Smart Request Policies", path: "/workers/smart-request-policies/" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    files.set(
      `${comparisonFixture.root}/README.md`,
      "See docs/workers/smart-request-policies.md for Smart Request Policies.\n",
    );

    const result = runDocsCheck(files);

    expect(result).toEqual({ exitCode: 0, output: "docs check passed" });
  });
});

function createFixtureFiles(): Map<string, string> {
  return new Map(
    comparisonFixture.files.map((file) => [
      `${comparisonFixture.root}/${file.path}`,
      file.contents,
    ]),
  );
}

function runDocsCheck(files: Map<string, string>): { exitCode: number; output: string } {
  const output: string[] = [];
  const script = fileContents("scripts/check-docs.mjs").replace(
    'import { readFileSync } from "node:fs";',
    "",
  );
  const readFileSync = (path: string): string => {
    const contents = files.get(`${comparisonFixture.root}/${path}`);
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  };
  const consoleLike = {
    error: (message: string) => output.push(message),
    log: (message: string) => output.push(message),
  };
  const processLike = {
    exit(code: number) {
      throw new DocsCheckExit(code);
    },
  };

  try {
    new Function("readFileSync", "console", "process", script)(
      readFileSync,
      consoleLike,
      processLike,
    );
    return { exitCode: 0, output: output.join("\n") };
  } catch (error) {
    if (error instanceof DocsCheckExit) {
      return { exitCode: error.code, output: output.join("\n") };
    }
    throw error;
  }
}

class DocsCheckExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`docs check exited with ${code}`);
    this.code = code;
  }
}

function fileContents(path: string): string {
  const file = comparisonFixture.files.find((candidate) => candidate.path === path);
  expect(file, `missing fixture file ${path}`).toBeTruthy();
  return file?.contents ?? "";
}
