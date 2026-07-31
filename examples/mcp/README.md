# Deploy a Computer MCP

This example exposes Computer through MCP. It gives an MCP client one durable workspace, a fast Worker shell, and a full Linux container behind a single Code Mode `code` tool.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/computer/tree/main/examples/mcp)

To copy the example into a standalone project, start Docker and run:

```bash
npm create cloudflare@latest computer-mcp -- \
  --template=cloudflare/computer/examples/mcp
```

C3 installs the dependencies and offers to deploy the project. You can then edit and redeploy it from the new `computer-mcp` directory.

To build and deploy from a clone of this repository instead, run:

```bash
npm install
npm run build --workspace @cloudflare/computer
npm run deploy --workspace @example/computer-mcp
```

The endpoint fails closed until you set `MCP_TOKEN`. Generate a random token rather than reusing a password:

```bash
openssl rand -hex 32
```

After deployment, add the result as an encrypted Worker secret in the Cloudflare dashboard. From a standalone project, you can set it with:

```bash
npx wrangler secret put MCP_TOKEN
```

From a clone of this repository, specify the example configuration:

```bash
npx wrangler secret put MCP_TOKEN --config examples/mcp/wrangler.jsonc
```

## Connect

Configure your MCP client to use the remote HTTP endpoint:

```text
https://<your-worker>.workers.dev/mcp
```

Send the token on every MCP request:

```text
Authorization: Bearer <MCP_TOKEN>
```

For clients that accept MCP server configuration as JSON, the entry typically looks like this:

```json
{
  "mcpServers": {
    "computer": {
      "type": "http",
      "url": "https://<your-worker>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

The exact configuration filename and format depend on the client. Keep the token in the client's secret storage when it provides one rather than committing it to a configuration file.

The Worker's root URL prints its MCP endpoint and available backends. `GET /health` returns `ok` without authentication.

## Use it

Once connected, ask your MCP client to work in the Computer workspace. For example:

```text
Create /workspace/hello.txt, read it back, and list the workspace files.
```

Commands use `worker-shell` by default. Select the container when the task needs a full Linux environment:

```text
Use container-shell to create a small Node.js project in /workspace, install its dependencies, and run its tests.
```

The client sees one public MCP tool named `code`. The model uses that tool to write a small JavaScript function that combines Computer's durable filesystem and command tools:

```js
async () => {
  await codemode.write({
    path: "/workspace/package.json",
    content: JSON.stringify({ scripts: { test: "node --test" } }),
  });

  const result = await codemode.exec({
    command: "npm test",
    backend: "container-shell",
  });

  return { exitCode: result.exitCode, stdout: result.stdout };
}
```

You do not need to call the underlying Computer tools individually. The `code` tool describes these functions and backends to the model:

| Function | Purpose |
| --- | --- |
| `codemode.read({ path, offset?, byteOffset?, limit? })` | Read bounded text or model-supported media. |
| `codemode.ls({ path, limit?, offset? })` | List one page of a directory. |
| `codemode.find({ path, pattern, limit?, offset? })` | Find paths matching a glob. |
| `codemode.grep({ path, query, ... })` | Search workspace text. |
| `codemode.write({ path, content })` | Create or replace a file. |
| `codemode.edit({ path, edits })` | Apply exact text replacements to a file. |
| `codemode.delete_({ path, recursive? })` | Delete a file or directory. |
| `codemode.exec({ command, cwd?, backend?, env? })` | Run a command, using `worker-shell` unless another backend is selected. |

## How it works

`@cloudflare/codemode` runs Code Mode orchestration code in an isolated Dynamic Worker with outbound networking disabled. Tool calls return to the Durable Object and operate on its Computer workspace.

| Backend | Use it for |
| --- | --- |
| `worker-shell` | The fast default for common commands. It has no ambient network access; its built-in Git command supports HTTPS remotes. |
| `container-shell` | Full Debian Linux with Node.js, npm, git, native binaries, and outbound networking. |

The model can select a backend in `codemode.exec()`. The example does not retry automatically, so backend choice, cost, and failures remain visible.

The container starts only when `container-shell` is selected. Computer synchronizes `/workspace` between the Durable Object and the container's FUSE mount before and after each command.

## Run locally

Local development requires a running Docker daemon for the Linux container. From the repository root:

```bash
npm install
npm run build --workspace @cloudflare/computer
printf 'MCP_TOKEN=development-token\n' > examples/mcp/.dev.vars
npm run dev --workspace @example/computer-mcp
```

The explicit build step is needed only when working from this repository; a standalone C3 project installs the published Computer package. On the first run, Wrangler also builds the container image. Connect to `http://127.0.0.1:8787/mcp` with the same bearer token.

## Validate

```bash
npm run typecheck --workspace @example/computer-mcp
npm test --workspace @example/computer-mcp
```

The workerd integration test authenticates a real MCP client, verifies that only `code` is public, runs filesystem and Worker-shell operations, and confirms that files persist across calls. It does not start the Linux container.

## Debug

Check the public routes first:

```bash
curl https://<your-worker>.workers.dev/health
curl https://<your-worker>.workers.dev/
```

Then stream Worker and Durable Object logs:

```bash
npx wrangler tail --config examples/mcp/wrangler.jsonc
```

A `401` means the bearer token is missing or incorrect. A `503` means `MCP_TOKEN` has not been configured. Backend failures are returned in the `codemode.exec()` result with the selected backend name.

## Security model

This example is intentionally single-user. Every authenticated request reaches the same Durable Object and workspace. Keep `MCP_TOKEN` private and deploy a separate copy for each trust boundary.

Code Mode's orchestration Worker and the Worker shell cannot make arbitrary outbound requests. The Worker shell's built-in Git command can use HTTPS remotes. The Linux container has outbound access so package managers and development tools work.

For a multi-user service, replace the bearer-token check with OAuth, derive the Durable Object name from the authenticated subject, and add per-user execution and storage limits.
