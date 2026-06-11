export interface FixtureFile {
  path: string;
  contents: string;
}

export interface ComparisonFixture {
  root: string;
  task: string;
  files: FixtureFile[];
}

export const comparisonFixture: ComparisonFixture = {
  root: "/workspace/repo",
  task: [
    "Add documentation for Smart Request Policies.",
    "Use the feature brief, style guide, existing Workers docs, and examples to create a new Workers docs page, update the docs navigation, add a Worker example, and update the README.",
    "Write the docs changes first; when the content is complete, run the available docs validation command if useful and summarize what changed and how you verified it.",
  ].join(" "),
  files: [
    {
      path: "package.json",
      contents: `${JSON.stringify(
        {
          scripts: {
            check: "node scripts/check-docs.mjs",
          },
          dependencies: {},
          devDependencies: {},
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "README.md",
      contents: `# Workers docs fixture\n\nThis repository is a small stand-in for Cloudflare Workers documentation. It contains existing docs pages, examples, navigation metadata, and feature briefs that should be used together when adding a new feature page.\n\n## Current sections\n\n- Workers overview\n- Routing\n- Security\n- Examples\n\nRun \`npm run check\` after documentation changes are complete to verify the new page, navigation entry, and example requirements.\n`,
    },
    {
      path: "style-guide.md",
      contents: `# Workers docs style guide\n\n## Voice\n\nWrite in a direct, helpful style for developers building on Cloudflare Workers. Prefer concrete examples over abstract platform language.\n\n## Frontmatter\n\nEvery docs page must begin with YAML frontmatter containing \`title\`, \`description\`, and \`lastUpdated\`. Use an ISO date for \`lastUpdated\`.\n\n## Workers docs style\n\n- Start with a short explanation of what the feature does.\n- Include a small Worker example when the feature affects request handling.\n- Mention beta limitations in a clearly labeled section.\n- Link to related Workers docs using relative links.\n- Avoid marketing claims such as "best", "magic", or "instant".\n`,
    },
    {
      path: "docs-nav.json",
      contents: `${JSON.stringify(
        {
          sections: [
            {
              title: "Workers",
              items: [
                { title: "Overview", path: "/workers/" },
                { title: "Routing", path: "/workers/routing/" },
                { title: "Security", path: "/workers/security/" },
              ],
            },
            {
              title: "Examples",
              items: [
                {
                  title: "Authenticated API",
                  path: "/workers/examples/authenticated-api/",
                },
                { title: "Rate limit", path: "/workers/examples/rate-limit/" },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "feature-briefs/smart-request-policies.md",
      contents: `# Smart Request Policies\n\nSmart Request Policies let Workers evaluate incoming requests against declarative method, path, header, and risk-signal rules before application handlers run. The feature is in beta for Enterprise customers.\n\n## Audience\n\nDevelopers who maintain API Workers, internal tooling, and report export endpoints.\n\n## Core behavior\n\n- Policies run at the start of a Worker request.\n- Safe methods such as \`GET\` and \`HEAD\` can be allowed without a bypass token.\n- Mutating methods such as \`POST\`, \`PUT\`, \`PATCH\`, and \`DELETE\` should require an explicit bypass token when the route handles sensitive exports.\n- Enterprise report exports may use a route-specific bypass token for scheduled jobs.\n- Denied requests should return a short reason string suitable for logs.\n\n## Docs requirements\n\n- Create \`docs/workers/smart-request-policies.md\`.\n- Add the new page to the Workers section in \`docs-nav.json\`.\n- Include a Worker example that checks method, pathname, and an \`x-bypass-token\` header.\n- Mention that beta policies do not replace application authorization.\n- Update the repository README so maintainers can find the new page.\n\n## Related topics\n\n- Routing rules are documented in \`docs/workers/routing.md\`.\n- Security recommendations are documented in \`docs/workers/security.md\`.\n`,
    },
    {
      path: "docs/workers/index.md",
      contents: `---\ntitle: Workers overview\ndescription: Build serverless applications on Cloudflare's global network.\nlastUpdated: 2026-05-20\n---\n\n# Workers overview\n\nCloudflare Workers run JavaScript and TypeScript close to users. Workers can inspect requests, route traffic, call storage services, and generate responses without managing servers.\n\n## Common tasks\n\n- Route requests to different origins.\n- Protect APIs with request checks.\n- Transform responses at the edge.\n- Connect to Cloudflare storage and AI services.\n\nFor request routing details, see [Routing](./routing.md). For security patterns, see [Security](./security.md).\n`,
    },
    {
      path: "docs/workers/routing.md",
      contents: `---\ntitle: Workers routing\ndescription: Route requests in Workers using URL and method checks.\nlastUpdated: 2026-05-21\n---\n\n# Workers routing\n\nWorkers receive a \`Request\` object and can branch on method, pathname, headers, and other request metadata.\n\n~~~ts\nexport default {\n  async fetch(request: Request): Promise<Response> {\n    const url = new URL(request.url);\n\n    if (request.method === "GET" && url.pathname === "/health") {\n      return Response.json({ ok: true });\n    }\n\n    return new Response("Not found", { status: 404 });\n  },\n};\n~~~\n\nKeep routing checks close to the code that handles the matching request.\n`,
    },
    {
      path: "docs/workers/security.md",
      contents: `---\ntitle: Workers security\ndescription: Apply request validation and authorization checks in Workers.\nlastUpdated: 2026-05-22\n---\n\n# Workers security\n\nWorkers can enforce lightweight request checks before calling application code. Use these checks together with application authorization and origin-side controls.\n\n## Recommendations\n\n- Validate methods before handling mutating routes.\n- Treat headers as untrusted input unless they are set by trusted infrastructure.\n- Return short denial reasons for logs without exposing sensitive policy details to callers.\n- Keep security checks explicit and easy to review.\n`,
    },
    {
      path: "docs/workers/examples/authenticated-api.md",
      contents: `---\ntitle: Authenticated API example\ndescription: Check an authorization header before proxying an API request.\nlastUpdated: 2026-05-23\n---\n\n# Authenticated API example\n\nThis Worker checks a bearer token before forwarding traffic to an API origin.\n\n~~~ts\nexport default {\n  async fetch(request: Request, env: Env): Promise<Response> {\n    const token = request.headers.get("authorization");\n\n    if (token !== "Bearer " + env.API_TOKEN) {\n      return new Response("Unauthorized", { status: 401 });\n    }\n\n    return fetch(request);\n  },\n};\n~~~\n\nUse application-specific authorization for user and tenant decisions.\n`,
    },
    {
      path: "docs/workers/examples/rate-limit.md",
      contents: `---\ntitle: Rate limit example\ndescription: Apply a simple path-specific request limit in a Worker.\nlastUpdated: 2026-05-24\n---\n\n# Rate limit example\n\nThis example shows where request protection logic can run before application handlers.\n\n~~~ts\nexport default {\n  async fetch(request: Request): Promise<Response> {\n    const url = new URL(request.url);\n\n    if (url.pathname.startsWith("/api/") && request.method !== "GET") {\n      return new Response("Limited", { status: 429 });\n    }\n\n    return new Response("OK");\n  },\n};\n~~~\n`,
    },
    {
      path: "docs/_partials/beta-note.md",
      contents: `> Beta features can change before general availability. Test policies in a staging environment before using them for production request handling.\n`,
    },
    {
      path: "scripts/check-docs.mjs",
      contents: `import { readFileSync } from "node:fs";

const failures = [];

function readRequired(path, purpose) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    failures.push(path + " is required for " + purpose + ". Create or repair this file, then rerun npm run check.");
    return "";
  }
}

function parseJson(path, source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    failures.push(path + " must contain valid JSON. Repair the JSON syntax, then rerun npm run check.");
    return {};
  }
}

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

const pagePath = "docs/workers/smart-request-policies.md";
const page = readRequired(pagePath, "the Smart Request Policies docs page");
const nav = parseJson("docs-nav.json", readRequired("docs-nav.json", "the Workers navigation entry"));
const readme = readRequired("README.md", "the maintainer-facing page link");

assert(page.startsWith("---\\n"), pagePath + " must start with YAML frontmatter containing title, description, and lastUpdated.");
assert(page.includes("title:"), pagePath + " frontmatter must include title.");
assert(page.includes("description:"), pagePath + " frontmatter must include description.");
assert(page.includes("lastUpdated:"), pagePath + " frontmatter must include lastUpdated.");
assert(page.includes("Smart Request Policies"), pagePath + " must describe Smart Request Policies by name.");
assert(page.includes("x-bypass-token"), pagePath + ' must include the exact header name "x-bypass-token". Add it to the Worker example or policy explanation.');
assert(page.includes("Enterprise report exports"), pagePath + ' must include the exact phrase "Enterprise report exports". Explain how scheduled Enterprise report exports can use a route-specific bypass token.');
assert(page.includes("~~~ts") || page.includes("\`\`\`ts"), pagePath + ' must include a fenced TypeScript Worker example using ~~~ts or "three-backtick ts".');
assert(!page.includes("TODO"), pagePath + " must not contain TODO placeholders. Replace placeholders with final docs content.");

const sections = Array.isArray(nav.sections) ? nav.sections : [];
const workers = sections.find((section) => section && section.title === "Workers");
assert(workers, "docs-nav.json must contain the Workers section.");
const workerItems = Array.isArray(workers?.items) ? workers.items : [];
assert(
  workerItems.some((item) => item && item.path === "/workers/smart-request-policies/"),
  'docs-nav.json must include a Workers item with path "/workers/smart-request-policies/".',
);
assert(
  readme.includes("smart-request-policies"),
  'README.md must include "smart-request-policies" so maintainers can find the new page.',
);

if (failures.length > 0) {
  console.error(["docs validation failed:", "", ...failures.map((failure, index) => String(index + 1) + ". " + failure)].join("\\n"));
  process.exit(1);
}

console.log("docs check passed");
`,
    },
  ],
};
