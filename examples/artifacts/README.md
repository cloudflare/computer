# Workspace Artifacts example

This example generates a Worker project in a Workspace, publishes it to Cloudflare Artifacts, and returns a clone-ready URL.

Run it with Wrangler:

```sh
npm run dev --workspace @example/computer-artifacts
```

Or deploy it and test against the remote runtime:

```sh
npx wrangler deploy --config examples/artifacts/wrangler.jsonc
```

Create a generated Worker by posting a Worker-safe name:

```sh
curl -X POST http://localhost:8787/create \
  -H 'content-type: application/json' \
  -d '{"name":"my-generated-worker"}'
```

Against a deployed Worker:

```sh
curl -X POST https://<worker-subdomain>.workers.dev/create \
  -H 'content-type: application/json' \
  -d '{"name":"my-generated-worker"}'
```

The Worker endpoint owns the orchestration. The durable object stays minimal: it owns the `Workspace`, exposes `getWorkspace()`, and bridges the host Artifacts binding into the worker-backend shell's `artifacts` command.

`POST /create` does the following through `ws.shell.exec(...)`:

1. clones `https://github.com/cloudflare/computer` into `/workspace/<name>-source`;
2. copies `/workspace/<name>-source/examples/worker` to `/workspace/<name>`;
3. rewrites the copied Worker name with `sed`;
4. initializes and commits the generated project with the shell `git` command;
5. runs `artifacts create <name> --remote origin --force` — one command that creates the session-scoped Artifact repo, mints a write token, and registers the credentialed remote as `origin`;
6. pushes `HEAD:main` to `origin`;
7. runs `artifacts share <name> --scope read` — one command that mints a short-lived read token and returns a single clone-ready URL — and returns a clone command built from it.

A successful response looks like:

```json
{
  "name": "my-generated-worker",
  "artifactRepo": "my-generated-worker",
  "remote": "https://<account>.artifacts.cloudflare.net/git/computer-artifacts-example/<repo>.git",
  "branch": "main",
  "projectDir": "/workspace/my-generated-worker",
  "shareLink": "https://x:<token>@<account>.artifacts.cloudflare.net/git/computer-artifacts-example/<repo>.git",
  "cloneCommand": "git clone 'https://x:<token>@<account>.artifacts.cloudflare.net/git/computer-artifacts-example/<repo>.git' my-generated-worker"
}
```

Treat `shareLink` and `cloneCommand` as secrets. The embedded read token expires after 24 hours.

The Artifacts binding is configured with `remote: true`, so local `wrangler dev` talks to the remote Artifacts service.
