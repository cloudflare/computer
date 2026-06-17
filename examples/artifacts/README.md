# Workspace Artifacts example

This example generates a Worker project in a Workspace, publishes it to Cloudflare Artifacts, and returns a clone-ready URL.

Run it with Wrangler:

```sh
npm run dev --workspace @example/workspace-artifacts
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

1. clones `https://github.com/cloudflare/workspace` into `/workspace/<name>-source`;
2. copies `/workspace/<name>-source/examples/worker` to `/workspace/<name>`;
3. rewrites the copied Worker name with `sed`;
4. initializes and commits the generated project with the shell `git` command;
5. replaces any prior session-scoped Artifact repo with the shell `artifacts` command;
6. pushes `HEAD:main` to the Artifact remote;
7. creates a short-lived read token with the shell `artifacts` command and returns a clone command.

A successful response looks like:

```json
{
  "name": "my-generated-worker",
  "artifactRepo": "my-generated-worker",
  "remote": "https://<account>.artifacts.cloudflare.net/git/workspace-artifacts-example/<repo>.git",
  "branch": "main",
  "projectDir": "/workspace/my-generated-worker",
  "shareLink": "https://x:<token>@<account>.artifacts.cloudflare.net/git/workspace-artifacts-example/<repo>.git",
  "cloneCommand": "git clone 'https://x:<token>@<account>.artifacts.cloudflare.net/git/workspace-artifacts-example/<repo>.git' my-generated-worker",
  "tokenExpiresAt": "2026-06-17T00:00:00.000Z"
}
```

Treat `shareLink` and `cloneCommand` as secrets. The embedded read token expires after 24 hours.

The Artifacts binding is configured with `remote: true`, so local `wrangler dev` talks to the remote Artifacts service.
