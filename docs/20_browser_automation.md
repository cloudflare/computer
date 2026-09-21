# Browser automation

Computer reaches Cloudflare Browser Run from both execution backends. `@cloudflare/computer/plugins/puppeteer` gives `WorkerJavaScriptBackend` a bundled Puppeteer client, and `@cloudflare/computer/shell/browser` gives `WorkerShellBackend` a `browser` command that runs a task module from the Workspace.

Both paths end in the same place. Puppeteer, its `Browser`, and its `Page` objects stay inside an isolated JavaScript Dynamic Worker, and Chromium runs in Browser Run. The shell command does not drive a browser itself; it dispatches the task into the JavaScript backend and reports the structured result.

Reach for the plugin when your own code decides what to browse, since it hands you the browser directly and returns a structured value. Reach for the command when something working in the shell decides, such as an agent composing a pipeline, because a task stored in the Workspace can be listed, edited, and rerun by name. Installing both costs one extra backend registration, and the example does exactly that.

## Configure the plugin

The host Worker needs Worker Loader and Browser Run bindings:

```jsonc
{
  "compatibility_flags": ["nodejs_compat", "experimental"],
  "worker_loaders": [{ "binding": "LOADER" }],
  "browser": { "binding": "BROWSER" }
}
```

Pass both bindings to the backend:

```ts
import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { puppeteer } from "@cloudflare/computer/plugins/puppeteer";

export class BrowserWorkspace extends DurableObject<Env> {
  readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new WorkerJavaScriptBackend({
          loader: env.LOADER,
          plugins: [puppeteer({ browser: env.BROWSER })],
        }),
      ],
    });
  }
}
```

The plugin bundles the Worker-compatible Puppeteer client, so the application does not need a separate runtime dependency on `@cloudflare/puppeteer`.

## Run a browser task

Code passed to `workspace.runtime.exec()` imports the configured module normally:

```ts
using execution = await workspace.runtime.exec(
  `
    import { withBrowser } from "@cloudflare/puppeteer";

    export default (input) => withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(input.url, { waitUntil: "domcontentloaded" });
      return { title: await page.title(), finalUrl: page.url() };
    }, {
      guardrails: {
        allowedDomains: [input.hostname, "*." + input.hostname],
        allowedDomainSets: ["common-cdns"],
      },
    });
  `,
  {
    input: {
      url: "https://developers.cloudflare.com/agents/",
      hostname: "developers.cloudflare.com",
    },
  },
);

const result = await execution.result();
```

Confining a session to the single requested host is usually too tight. Pages pull fonts, images, and scripts from subdomains and shared CDNs, so a page rendered under that policy comes out half-loaded. The shell `browser` command applies the wider policy above by default when it is given a `--url`.

`withBrowser(callback, options?)` launches a connection-bound browser, runs the callback, and closes the browser afterward. Use `launch(options?)` when code needs to manage the browser itself:

```js
import { launch } from "@cloudflare/puppeteer";

const browser = await launch();
try {
  // Use Puppeteer normally.
} finally {
  await browser.close();
}
```

The module also exports `browserBinding`, the unchanged upstream default export, and upstream runtime exports. `browserBinding` is useful for APIs such as `puppeteer.sessions()` that take the Browser Run binding directly.

Do not return Puppeteer objects from an execution. Return structured data or write larger output to the Workspace.

## Run a browser task from the shell

The Worker shell reaches the same capability through a `browser` command. Import the command group and pass it alongside any other shell commands:

```ts
import browser from "@cloudflare/computer/shell/browser";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";

new WorkerShellBackend({
  loader: env.LOADER,
  workspace: { binding: "BrowserWorkspace", id: ctx.id.toString() },
  ctx,
  commands: [browser],
});
```

The command needs a JavaScript backend carrying the Puppeteer plugin in the same Workspace, because that is where the task actually runs. It dispatches to the backend named `worker-javascript`, and reads `BROWSER_BACKEND` from the shell environment to pick another. That target has to accept structured input, which in practice means a JavaScript backend; anything else fails with a message saying the backend is not callable. Since the variable is shell-settable, a script can aim the command at any such backend in the same Workspace, which is the same authority the shell already has through the Workspace runtime and worth knowing when deciding which backends share one.

A task module exports a default function that receives the browser alongside the caller's input:

```js
// /workspace/tasks/title.js
export default async ({ url, browser }) => {
  const page = await browser.newPage();
  await page.goto(url);
  return { title: await page.title() };
};
```

```sh
browser puppeteer --url https://developers.cloudflare.com/agents/ tasks/title.js
browser puppeteer --url https://developers.cloudflare.com/agents/ --stdin < tasks/title.js
```

The command prints the returned value as JSON and exits with the task's exit code. `--timeout <ms>` sets the execution budget, and `--input <json>` merges a JSON object into the task input. The task runs in the JavaScript backend, so it can write to the Workspace through `node:fs/promises` exactly as an inline module does.

The browser is opened and closed around the task by the generated entry, so a task never manages the session itself. Scripts stored in the Workspace survive the execution that wrote them, which is what makes a task worth naming: the shell can rerun it, and the JavaScript backend can import it.

## Save browser output

Worker JavaScript provides Workspace-backed `node:fs` and `node:fs/promises`. A screenshot can be written without returning its bytes through the structured result:

```js
import { withBrowser } from "@cloudflare/puppeteer";
import fs from "node:fs/promises";

export default (input) => withBrowser(async (browser) => {
  const page = await browser.newPage();
  await page.goto(input.url);
  await fs.writeFile(input.outputPath, await page.screenshot({ type: "png" }));
  return { title: await page.title(), outputPath: input.outputPath };
});
```

The Dynamic Worker is disposable, but files written to the Workspace remain available to later executions.

## Authority and limits

Installing the plugin grants every execution on that backend access to its public browser API. Put browser-enabled work on a separate named backend when only some callers should have that authority. Plugins installed on one backend are mutually trusted and share the plugin binding authority domain; caller modules and ordinary configured modules cannot import the internal binding bridge.

Browser navigation happens through Browser Run, not through the backend's `globalOutbound` policy. Validate user input and set Browser Run guardrails when the application accepts URLs from other users.

Computer execution timeouts and Puppeteer navigation timeouts are separate. Set both for the workload. `withBrowser()` closes the browser after normal completion or an error. Cancellation and timeout dispose the Dynamic Worker and its client connection, so application cleanup code may not finish in those paths.

Screenshots are encoded when they cross the Workspace filesystem bridge. For larger screenshots, raise the capability limits deliberately:

```ts
new WorkerJavaScriptBackend({
  loader: env.LOADER,
  plugins: [puppeteer({ browser: env.BROWSER })],
  maxCapabilityBytes: 8 * 1024 * 1024,
  maxCapabilityRequestBytes: 16 * 1024 * 1024,
});
```

See [`examples/browser-rendering`](../examples/browser-rendering) for a runnable example that stores one task and runs it both ways, writing the same Markdown, JSON, and screenshot output to a durable Workspace from either path.
