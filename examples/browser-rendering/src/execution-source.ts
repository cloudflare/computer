// The browser task this example runs, and the two ways it is invoked.
//
// TASK_SOURCE is seeded into the Workspace at TASK_PATH. It is an
// ordinary module with a default function, which is the shape the
// `browser` shell command expects: the caller's input arrives with a
// live browser attached. Nothing in it is specific to either path,
// which is what lets both produce byte-identical artifacts.
//
// JAVASCRIPT_ENTRY is what the JavaScript path executes. It is the
// plugin integration in full: import withBrowser, call the task
// inside it. The shell command generates the same wrapper itself, so
// the CLI path runs this module without an entry of its own.

/** Directory the task module is seeded into. */
export const TASK_DIRECTORY = "/workspace/tasks";

/** Workspace path of the shared task module. */
export const TASK_PATH = `${TASK_DIRECTORY}/report.js`;

/** Root the task writes its per-run output under. */
export const RUNS_DIRECTORY = "/workspace/browser-runs";

/**
 * Budget for the browser work itself. The shell path adds headroom
 * on top for the command's own dispatch, so the inner execution is
 * the one that times out first and reports why.
 */
export const TASK_TIMEOUT_MS = 60_000;

export const TASK_SOURCE = String.raw`import fs from "node:fs/promises";

// The task receives a live browser from whoever invoked it. The
// JavaScript entry and the shell command both open it the same way,
// so this module never manages a session itself.

function buildMarkdown(page) {
  const lines = [
    "# " + page.title,
    "",
    page.description || page.summary || "No summary was available.",
    "",
    "## Page snapshot",
    "",
    "- URL: " + page.finalUrl,
    "- HTTP status: " + (page.status ?? "unknown"),
    "- Language: " + (page.language || "unknown"),
    "- Elements: " + page.document.elements,
    "- Images: " + page.document.images,
    "- Links: " + page.document.links,
    "",
    "## Sections",
    "",
  ];

  for (const section of page.sections) {
    lines.push("- " + section.level.toUpperCase() + ": " + section.text);
  }

  lines.push("", "## Code samples", "");
  if (page.codeSamples.length === 0) lines.push("No code samples found.", "");
  for (const [index, sample] of page.codeSamples.entries()) {
    lines.push("### Sample " + (index + 1), "");
    for (const line of sample.text.split("\n")) lines.push("    " + line);
    lines.push("");
  }

  lines.push("## Internal links", "");
  for (const link of page.internalLinks) {
    lines.push("- [" + (link.text || link.href) + "](" + link.href + ")");
  }
  return lines.join("\n") + "\n";
}

export default async function report({ url, browser }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.setDefaultNavigationTimeout(30_000);
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });

  const extracted = await page.evaluate(() => {
    const clean = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const sections = [...document.querySelectorAll("h1, h2, h3, h4")]
      .map((heading) => ({
        level: heading.tagName.toLowerCase(),
        text: clean(heading.textContent),
      }))
      .filter((heading) => heading.text)
      .slice(0, 80);
    const codeSamples = [...document.querySelectorAll("pre")]
      .map((sample) => ({ text: sample.textContent?.trim().slice(0, 4_000) ?? "" }))
      .filter((sample) => sample.text)
      .slice(0, 12);
    const seenLinks = new Set();
    const internalLinks = [...document.querySelectorAll("a[href]")]
      .map((anchor) => ({ text: clean(anchor.textContent), href: anchor.href }))
      .filter((link) => {
        try {
          const target = new URL(link.href);
          if (target.hostname !== location.hostname || seenLinks.has(target.href)) return false;
          seenLinks.add(target.href);
          return true;
        } catch {
          return false;
        }
      })
      .slice(0, 80);
    const paragraphs = [...document.querySelectorAll("main p, article p")]
      .map((paragraph) => clean(paragraph.textContent))
      .filter((text) => text.length > 60)
      .slice(0, 6);
    return {
      description: document.querySelector('meta[name="description"]')?.content ?? null,
      language: document.documentElement.lang || null,
      summary: paragraphs.join(" ").slice(0, 2_400),
      sections,
      codeSamples,
      internalLinks,
      document: {
        elements: document.querySelectorAll("*").length,
        images: document.images.length,
        links: document.links.length,
        scripts: document.scripts.length,
      },
    };
  });

  const pageData = {
    requestedUrl: url,
    finalUrl: page.url(),
    status: response?.status() ?? null,
    title: await page.title(),
    ...extracted,
  };

  const markdown = buildMarkdown(pageData);
  const json = JSON.stringify(pageData, null, 2) + "\n";
  const png = await page.screenshot({ type: "png", fullPage: true });

  // The run directory is chosen here rather than by the caller, so a
  // run started from the shell lands beside one started from the
  // JavaScript path.
  const outputDirectory = "${RUNS_DIRECTORY}/" + crypto.randomUUID();
  const reportPath = outputDirectory + "/report.md";
  const dataPath = outputDirectory + "/page.json";
  const screenshotPath = outputDirectory + "/screenshot.png";

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(reportPath, markdown);
  await fs.writeFile(dataPath, json);
  await fs.writeFile(screenshotPath, png);

  return {
    ...pageData,
    outputDirectory,
    reportPath,
    dataPath,
    screenshotPath,
    files: [
      {
        name: "report.md",
        path: reportPath,
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode(markdown).byteLength,
      },
      {
        name: "page.json",
        path: dataPath,
        mediaType: "application/json",
        bytes: new TextEncoder().encode(json).byteLength,
      },
      {
        name: "screenshot.png",
        path: screenshotPath,
        mediaType: "image/png",
        bytes: png.byteLength,
      },
    ],
  };
}`;

export const JAVASCRIPT_ENTRY = `import { withBrowser } from "@cloudflare/puppeteer";
import report from "./report.js";

export default (input) => withBrowser((browser) => report({ ...input, browser }), {
  guardrails: {
    allowedDomains: [input.hostname, "*." + input.hostname],
    allowedDomainSets: ["common-cdns"],
  },
});`;

/**
 * Shell invocation for the same task. The command generates its own
 * entry, applies the same guardrails from `--url`, and prints the
 * task's return value as JSON.
 */
export function shellCommand(url: string): string {
  const script = TASK_PATH.slice(TASK_DIRECTORY.length + 1);
  return `browser puppeteer --url ${shellQuote(url)} --timeout ${TASK_TIMEOUT_MS} ${script}`;
}

// The URL reaches this example from a request body, and a URL may
// legally contain a single quote. Quote it the way a shell expects so
// the value can never become syntax.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Read the task's return value out of the command's stdout.
 *
 * The command prints anything the task logged before it prints the
 * value, so a task with a `console.log` in it would defeat a plain
 * parse. The value is the pretty-printed object at the end, which
 * starts at the last line that begins with a brace.
 */
export function parseCommandResult(stdout: string): unknown {
  const start = stdout.startsWith("{") ? 0 : stdout.lastIndexOf("\n{") + 1;
  const candidate = start > 0 || stdout.startsWith("{") ? stdout.slice(start) : "";
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error(`browser command printed no JSON result: ${stdout.trim().slice(0, 200)}`);
  }
}
