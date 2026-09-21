// Argv parsing and entry-module generation for the shell `browser`
// command.
//
// Kept free of just-bash and of any host binding so the behavioral
// choices are testable on their own. command.ts adapts this to the
// just-bash Command signature and dispatches the generated module
// into a browser-enabled worker-javascript backend.

/** Task run requested by a well-formed argv. */
export interface BrowserRunRequest {
  kind: "run";
  engine: "puppeteer";
  /** Task module path as written by the caller, resolved later against cwd. */
  script?: string;
  /** Whether the task module arrives on stdin instead of from a file. */
  stdin: boolean;
  url?: string;
  timeoutMs?: number;
  input?: Record<string, unknown>;
}

export type BrowserCommandRequest =
  | BrowserRunRequest
  | { kind: "help" }
  | { kind: "error"; message: string };

export const BROWSER_USAGE = `usage: browser puppeteer [options] <script>
       browser puppeteer [options] --stdin

Run a task module against a browser. The module's default export is
called with a live Puppeteer browser, and its return value is printed
as JSON.

  export default async ({ url, browser }) => {
    const page = await browser.newPage();
    await page.goto(url);
    return { title: await page.title() };
  };

Options:
  --url <url>        Page URL passed to the task as input.url. The
                     browser session is confined to its host, that
                     host's subdomains, and common CDNs.
  --stdin            Read the task module from standard input.
  --timeout <ms>     Execution budget for the whole task.
  --input <json>     JSON object merged into the task input.
  -h, --help         Show this message.

The task runs in the worker-javascript backend that carries the
Puppeteer plugin. Set BROWSER_BACKEND to select a different one.
`;

const ENGINES = new Set(["puppeteer"]);
const VALUE_FLAGS = new Set(["--url", "--timeout", "--input"]);

export function parseBrowserCommand(argv: readonly string[]): BrowserCommandRequest {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [engine, ...rest] = argv;
  if (engine === undefined) return error(`no engine given\n\n${BROWSER_USAGE}`);
  if (!ENGINES.has(engine)) {
    return error(`unknown engine ${JSON.stringify(engine)}; expected "puppeteer"`);
  }

  let script: string | undefined;
  let stdin = false;
  let url: string | undefined;
  let timeoutMs: number | undefined;
  let input: Record<string, unknown> | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--stdin") {
      stdin = true;
      continue;
    }
    if (argument.startsWith("-")) {
      const split = argument.indexOf("=");
      const name = split === -1 ? argument : argument.slice(0, split);
      if (!VALUE_FLAGS.has(name)) return error(`unknown option ${JSON.stringify(argument)}`);
      let value: string | undefined;
      if (split === -1) {
        index += 1;
        value = rest[index];
      } else {
        value = argument.slice(split + 1);
      }
      if (value === undefined) return error(`option ${name} needs a value`);
      if (name === "--url") {
        const parsed = parseUrl(value);
        if (parsed === undefined) {
          return error(`--url must be an http or https URL; got ${JSON.stringify(value)}`);
        }
        url = parsed;
        continue;
      }
      if (name === "--timeout") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return error(`--timeout must be a positive whole number of milliseconds`);
        }
        timeoutMs = parsed;
        continue;
      }
      const parsed = parseInput(value);
      if (parsed === undefined) return error("--input must be a JSON object");
      input = parsed;
      continue;
    }
    if (script !== undefined) return error("give one script path, not several");
    script = argument;
  }

  if (stdin && script !== undefined) {
    return error("read the task from a script path or from --stdin, not both");
  }
  if (!stdin && script === undefined) return error("give a script path or pass --stdin");

  return { kind: "run", engine: "puppeteer", script, stdin, url, timeoutMs, input };
}

/** Where a task module lives and how the generated entry reaches it. */
export interface ResolvedTaskPath {
  /** Absolute workspace path of the task module. */
  path: string;
  /** Directory the JavaScript execution runs from. */
  cwd: string;
  /** Relative specifier the generated entry imports. */
  specifier: string;
}

/**
 * Resolve a caller-written task path against the shell's working
 * directory. The execution runs from the task's own directory so the
 * generated entry can import it as a sibling, which is the only import
 * shape the JavaScript backend resolves from the Workspace.
 */
export function resolveTaskPath(cwd: string, script: string): ResolvedTaskPath {
  const absolute = script.startsWith("/") ? script : `${cwd}/${script}`;
  const segments: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const name = segments.pop();
  if (name === undefined) throw new Error(`browser: ${script} is not a task module path`);
  return {
    path: `/${[...segments, name].join("/")}`,
    cwd: `/${segments.join("/")}`,
    specifier: `./${name}`,
  };
}

/**
 * Entry module dispatched into the JavaScript backend. It imports the
 * caller's task, opens a browser for the call, and closes it once the
 * task settles.
 *
 * A `--url` narrows the Browser Run session to that URL's host, its
 * subdomains, and the common CDN set. Pages pull fonts, images, and
 * scripts from elsewhere, so confining a session to the single
 * requested host would leave most of them half-rendered. A task that
 * has to reach further should take its targets through `--input` and
 * leave `--url` off, which is the explicit way to ask for an
 * unconfined session.
 */
export function browserEntryModule(specifier: string, host?: string): string {
  const options =
    host === undefined
      ? "undefined"
      : JSON.stringify(
          {
            guardrails: {
              allowedDomains: [host, `*.${host}`],
              allowedDomainSets: ["common-cdns"],
            },
          },
          null,
          2,
        );
  return `import { withBrowser } from "@cloudflare/puppeteer";
import task from ${JSON.stringify(specifier)};

const launchOptions = ${options};

export default (input) => {
  if (typeof task !== "function") {
    throw new TypeError("browser: the task module must have a default function export");
  }
  return withBrowser((browser) => task({ ...input, browser }), launchOptions);
};
`;
}

function parseUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.toString();
}

function parseInput(value: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function error(message: string): BrowserCommandRequest {
  return { kind: "error", message };
}
