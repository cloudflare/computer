# Computer tools as one Codemode MCP server

This example turns Computer's native Workspace tools into a single Codemode MCP tool:

```text
MCP client
  → code
  → Codemode DynamicWorkerExecutor
  → read / ls / write / edit / exec
  → durable Computer Workspace
```

It does not add a Codemode backend to Computer. Codemode uses its built-in Dynamic Worker executor for the model-written orchestration code. Tool calls return to the host and invoke the same bounded Computer tools used by other integrations. Filesystem tools operate directly on durable Workspace storage; `exec` uses Computer's `worker-shell` backend with a 30-second limit per command.

`src/computer-mcp.ts` creates an internal MCP server from `createAITools()`. Codemode's `codeMcpServer()` discovers those tools, generates their JavaScript types, and exposes only one public MCP tool named `code`. Code running in Codemode sees the native tools as methods such as:

```js
async () => {
  await codemode.write({
    path: "/workspace/message.txt",
    content: "hello from codemode"
  });
  const file = await codemode.read({ path: "/workspace/message.txt" });
  const shell = await codemode.exec({ command: "pwd" });
  return { content: file.content, cwd: shell.stdout.trim() };
}
```

## Run locally

From the repository root:

```bash
npm install
npm run dev --workspace @example/computer-codemode
```

Connect a Streamable HTTP MCP client to:

```text
http://127.0.0.1:8787/mcp
```

The server advertises one `code` tool rather than exposing every filesystem and execution operation to the model separately. The example returns stateless JSON responses over POST-only Streamable HTTP; it deliberately does not open a session-bound GET event stream.

> [!WARNING]
> This is a local harness, not an authenticated multi-tenant service. A production host must derive the Durable Object and Workspace identity from an authenticated tenant and enforce authorization, request limits, execution limits, and storage quotas.

## Validate

```bash
npm run typecheck --workspace @example/computer-codemode
npm test --workspace @example/computer-codemode
```

The integration test connects with a real MCP client, verifies that only `code` is public, executes generated JavaScript through Codemode's Dynamic Worker, calls Computer's native filesystem and shell tools, and confirms that files persist in the durable Workspace across calls.
