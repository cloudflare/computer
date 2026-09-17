# Computer browser rendering example

One browser task, stored in a durable Workspace and run two ways: as a JavaScript module, and as a shell command. Both write the same three files, because both run the same module.

This is the runnable companion to [Browser automation](../../docs/20_browser_automation.md).

## Run it

You need a Cloudflare account with Browser Run access and a completed `wrangler login`. Runs spend Browser Run quota during local development as well as after deployment, because the binding reaches the real service either way.

From the repository root:

```sh
npm install
npm run build --workspace @cloudflare/computer
npm run dev --workspace @example/computer-browser-rendering
```

The build step is what the example imports: it depends on the package's built output rather than its sources. Local development needs no authentication.

Open the address Wrangler prints, leave the default URL in place, and run the JavaScript path. You should get a page title, an HTTP status, a full-page screenshot, and a run directory holding three files. Now run the shell path against the same URL. The invocation shown with the result changes, and the output does not.

## The task

The task is an ordinary module with a default function. It receives a live browser from whoever invoked it, so it never opens or closes a session itself. The example seeds it at `/workspace/tasks/report.js`:

```js
export default async ({ url, browser }) => {
  const page = await browser.newPage();
  await page.goto(url);
  return { title: await page.title() };
};
```

The seeded task is longer than that. It also pulls out a summary, headings, code samples, and links, and writes the three files described below. `src/execution-source.ts` holds the real one, and the interface will show it to you.

## Path one: a JavaScript module

Register the plugin on a Worker JavaScript backend:

```ts
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { puppeteer } from "@cloudflare/computer/plugins/puppeteer";

new WorkerJavaScriptBackend({
  loader: env.LOADER,
  plugins: [puppeteer({ browser: env.BROWSER })],
});
```

Executed modules then import the bound lifecycle helper:

```js
import { withBrowser } from "@cloudflare/puppeteer";
import report from "./report.js";

export default (input) => withBrowser((browser) => report({ ...input, browser }));
```

`withBrowser()` uses the configured Browser Run binding and closes the browser after the callback settles. `Browser`, `Page`, selectors, and page evaluation stay inside the Dynamic Worker.

## Path two: a shell command

Register the command group on a Worker shell backend in the same Workspace:

```ts
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import browser from "@cloudflare/computer/shell/browser";

new WorkerShellBackend({
  loader: env.LOADER,
  workspace: { binding: "BrowserWorkspace", id: ctx.id.toString() },
  ctx,
  commands: [browser],
});
```

The shell then runs the stored task by name:

```sh
browser puppeteer --url https://developers.cloudflare.com/agents/ report.js
```

The command generates the same wrapper shown above and dispatches it to the JavaScript backend, so the browser still runs there. It prints the task's return value as JSON.

## What the example adds

The rest of this directory is an example application, not code required by either path. Its web interface accepts a user-provided HTTP or HTTPS URL, and the stored task writes three files into one run directory:

```text
/workspace/browser-runs/<run-id>/
├── report.md
├── page.json
└── screenshot.png
```

The interface serves those files back over a validated artifact route and draws the run directory as a file tree. Because the run directory is chosen inside the task, a run started from the shell lands beside one started from the JavaScript path.

## Deploy it

Set a token first, because the deployed interface will run a browser for anyone who reaches it:

```sh
cd examples/browser-rendering
npx wrangler secret put DEMO_TOKEN
npm run deploy
```

The deployed site uses HTTP Basic authentication. The username is `demo` and the password is the secret you set.

The Worker needs the bindings in `wrangler.jsonc`, where one Worker Loader serves both backends:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "worker_loaders": [{ "binding": "LOADER" }],
  "browser": { "binding": "BROWSER" }
}
```

## Files

- `src/index.ts` registers both backends, seeds the task, and exposes the API and durable artifact routes.
- `src/execution-source.ts` holds the shared task module and the two invocations that run it.
- `src/artifact-response.ts` sets the media type and browser protections for stored files.
- `src/demo-auth.ts` gates the deployed site behind HTTP Basic authentication.
- `src/retryable-once.ts` retries task seeding after a failed write.
- `src/ui.ts` contains the dependency-free interface.
- `wrangler.jsonc` declares the Worker Loader, Browser Run, and Durable Object bindings.

The example requires authentication when deployed, applies Browser Run guardrails for the requested host, and uses connection-bound browser sessions. Add workload-specific URL policy and quota handling if you adapt it for a shared service.
