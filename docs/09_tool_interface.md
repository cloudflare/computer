# 09. Tool interface (agents)

`@cloudflare/computer/tools` ships ready-made tools for agents that use a `Workspace`. Three agent SDKs are supported from one implementation:

| SDK | Entrypoint | Factory |
| --- | --- | --- |
| [AI SDK](https://github.com/vercel/ai) (`ai`) | `@cloudflare/computer/tools` | `createAITools` |
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`) | `@cloudflare/computer/tools/pi` | `createPiTools` |
| [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai`) | `@cloudflare/computer/tools/tanstack` | `createTanStackTools` |

The tools wrap three Workspace surfaces:

- `workspace.fs` for file reads, writes, edits, searches, listings, and deletion;
- `workspace.runtime.exec` for command execution when the caller opts in;
- `workspace.assets` for publishing generated files when an assets publisher is configured.

Every factory takes the same options and produces the same tools with the same names, descriptions, schemas, and caps. Only the returned shape differs, because each SDK wants a different one. Each SDK's package is an optional peer dependency: importing one adapter does not require the other two to be installed.

## One implementation, three shapes

A tool is described once as a `ToolSpec` — a name, a description, a Zod input schema, an executor, and an optional model-output hook — and `createToolSpecs()` assembles the set for a Workspace. The three factories are thin adapters over that set, so a change to a tool's behavior, schema, or description reaches all three SDKs at once.

```
              createToolSpecs()          ← tool set, gating, schemas, caps
             /        |        \
   createAITools  createPiTools  createTanStackTools
        (ai)     (pi-ai, TypeBox)     (@tanstack/ai)
```

Where the SDKs genuinely differ, the adapter absorbs it:

| Concern | AI SDK | pi | TanStack AI |
| --- | --- | --- | --- |
| Schema | Zod, passed through | converted to JSON Schema for TypeBox | Zod, passed through (Standard Schema) |
| Execution | `execute` on the tool | caller's loop, via the returned `execute` dispatcher | `execute` on the tool |
| Streaming `exec` | progressive tool results | terminal snapshot | terminal snapshot, optional custom events |
| Images and PDFs | typed `file` output part | base64 `image` block (PDFs degrade to text) | base64 payload plus media type |

`createToolSpecs` and the `ToolSpec` types are exported, so a fourth SDK is an adapter rather than a rewrite.

## What ships

| Export | Purpose |
| --- | --- |
| `createAITools` | Create the default AI SDK `ToolSet` for a Workspace. |
| `createPiTools` | Create pi tool declarations plus their executor. |
| `createTanStackTools` | Create the TanStack AI tool record for a Workspace. |
| `createToolSpecs` | Build the SDK-neutral spec set the adapters share. |
| `createReadTool` | Stream text by line and pass images or PDFs to capable models. |
| `createWriteTool` | Write a whole file with a UTF-8 byte cap. |
| `createEditTool` | Apply atomic targeted replacements and return a unified diff. |
| `createListTool` | Page through one directory with file metadata. |
| `createFindTool` | Find paths with `*`, `**`, and `?` globs. |
| `createGrepTool` | Search text with regular expressions or fixed strings. |
| `createDeleteTool` | Delete a file or directory. |
| `createExecTool` | Run a command through a configured Workspace backend. |
| `createPublishTool` | Publish a workspace file through `workspace.assets`. |
| `WorkspaceFileStore` | Adapt `workspace.fs` to the store used by file tools. |

Every factory always names its tools `read`, `ls`, `find`, `grep`, `write`, `edit`, and `delete`. `exec` appears when the caller supplies `shell` options. `publish` appears when assets are configured. In read-only mode the set is `read`, `ls`, `find`, and `grep`.

## Wiring up

```ts
import { Workspace } from "@cloudflare/computer";
import { createAITools } from "@cloudflare/computer/tools";

export class Agent {
  workspace: Workspace;

  constructor(ctx: DurableObjectState) {
    this.workspace = new Workspace({ storage: ctx.storage });
  }

  getTools() {
    return createAITools({
      workspace: this.workspace,
      read: {
        maxBytes: 32 * 1024,
        maxLines: 800,
        includeLineNumbers: true,
        lineTruncation: { chars: 2000 },
      },
    });
  }
}
```

Pass the returned AI SDK `ToolSet` to `generateText`, `streamText`, or an agent framework hook such as `getTools()`.

### pi

pi splits a tool into data and execution: `Context.tools` carries declarations with TypeBox `parameters`, and the caller's own agent loop runs the calls. `createPiTools` returns both halves so they cannot drift apart.

```ts
import { createPiTools } from "@cloudflare/computer/tools/pi";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

const { tools, execute } = createPiTools({ workspace });
const models = builtinModels();
const model = models.getModel("anthropic", "claude-sonnet-4-5")!;

const context = {
  systemPrompt: "You are a coding agent working in /workspace.",
  messages: [{ role: "user", content: "Summarize the README.", timestamp: Date.now() }],
  tools,
};

// One turn of the caller's loop.
const message = await models.complete(model, context);
context.messages.push(message);

for (const block of message.content) {
  if (block.type !== "toolCall") continue;
  const { content, isError } = await execute(block);
  context.messages.push({
    role: "toolResult",
    toolCallId: block.id,
    toolName: block.name,
    content,
    isError,
    timestamp: Date.now(),
  });
}
```

`execute` validates the call's arguments against the tool's schema and returns pi `toolResult` content, reporting a bad call or a failed tool as `isError: true` so the model can retry instead of the loop throwing. The Zod schemas are converted to plain JSON Schema for TypeBox, so a field with a default stays optional for the model and pi applies the default during validation.

### TanStack AI

A TanStack tool is a plain object whose `inputSchema` is a Standard Schema, which Zod implements, so the schemas are passed through with no conversion. The result is the record `chat({ tools })` takes.

```ts
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";
import { createTanStackTools } from "@cloudflare/computer/tools/tanstack";

export async function POST(request: Request) {
  const { messages } = await request.json();
  const abortController = new AbortController();

  const tools = createTanStackTools({
    workspace,
    shell: { defaultBackend: "shell", backends: { shell: { description: "Worker shell." } } },
    approve: ["delete", "exec"],
    signal: abortController.signal,
  });

  return toServerSentEventsResponse(
    chat({
      adapter: anthropicText("claude-sonnet-4-5"),
      messages,
      tools,
      abortController,
    }),
  );
}
```

`approve` marks tools that should pause for confirmation through TanStack's `needsApproval`. Because the tool execution context carries no abort signal, pass `signal` to cancel a running `exec` when the request aborts. A TanStack tool settles on one value, so `exec` returns the run's terminal snapshot; set `streamEventName` to also forward each pre-terminal snapshot through `emitCustomEvent` for a live view of a command's output.

### Shared options

Pass `shell` only when the Workspace has matching backend ids:

```ts
const tools = createAITools({
  workspace,
  shell: {
    defaultBackend: "shell",
    backends: {
      shell: { description: "Fast Worker shell with built-in text commands." },
      container: { description: "Full Linux userland in a Cloudflare Container." },
    },
  },
});
```

## `createAITools`

```ts
createAITools({
  workspace,
  readonly?,
  assets?,
  read?,
  write?,
  edit?,
  shell?,
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `workspace` | required | A `Workspace` or structural equivalent. |
| `readonly` | `false` | Omit `write`, `edit`, `delete`, `exec`, and `publish`. Search remains available. |
| `assets` | `true` | Set to `false` to omit `publish`. |
| `read` | default caps | Options passed to `createReadTool`. |
| `write` | default caps | Options passed to `createWriteTool`. |
| `edit` | default caps | Options passed to `createEditTool`. |
| `shell` | omitted | Options passed to `createExecTool`. |

## `read`

```ts
createReadTool({
  store,
  maxLines?,
  maxBytes?,
  includeLineNumbers?,
  lineTruncation?,
  maxModelBytes?,
  mediaSniffBytes?,
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `maxLines` | 2000 | Hard line cap per call. |
| `maxBytes` | 256 KiB | Hard UTF-8 output cap per call. |
| `includeLineNumbers` | `false` | Prefix text lines with `${lineNumber}\t`. |
| `lineTruncation` | omitted | Shorten each line by `{ bytes }` or `{ chars }` before applying `maxBytes`. |
| `maxModelBytes` | 3.5 MiB | Largest image or PDF encoded into model output. |
| `mediaSniffBytes` | 512 | Prefix read when the extension does not identify the file. |

Schema:

```ts
{
  path: string;
  offset?: number;     // 1-indexed start line
  byteOffset?: number; // byte continuation from the previous result
  limit?: number;
}
```

A truncated text result has `totalLines: null`, `nextOffset`, and `nextByteOffset`. Pass both continuations to the next call. A positive `byteOffset` is valid only with `offset`; `byteOffset: 0` starts from the beginning. `nextOffset` preserves line numbering, while `nextByteOffset` opens the next database-backed stream at that byte instead of transferring bytes already read. The workspace adapter uses one ranged stream per tool call, including across Workers RPC; it does not issue one eager range RPC per chunk. The AI SDK model output keeps the complete result as JSON when a read is truncated, empty, or explicitly positioned. Other complete text reads remain plain text.

Known image and PDF extensions are classified without a prefix read. Unknown extensions use a bounded magic-byte and UTF-8 sniff. SVG source is returned as text rather than inline media. During execution, the tool reads at most `maxModelBytes + 1` bytes and captures eligible image or PDF data in the result. The `toModelOutput` hook performs no filesystem I/O and emits an AI SDK `file` part from those captured bytes, so regenerated prompt history cannot observe later file changes. Other binary files return an unsupported binary result.

## `ls`

```ts
{
  path: string;
  limit?: number;  // default 200, maximum 1000
  offset?: number;
}
```

`ls` defaults to at most 200 entries and returns this shape:

```ts
{
  path: string;
  count: number;
  entries: Array<{
    name: string;
    size: number;
    mtime: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }>;
  nextOffset?: number;
}
```

Entries are in name order. A non-final page includes `nextOffset`; pass it as the next call's `offset`.

## `find`

```ts
{
  path?: string;      // default /workspace
  pattern: string;
  exclude?: string[];
  limit?: number;     // default 200, maximum 1000
  offset?: number;
}
```

The pattern is relative to `path`. `*` stays within one path segment, `**` crosses directories, and `?` matches one non-separator character. Results contain `path` and `type`; a non-final page includes `nextOffset`. Pagination reaches `workspace.fs.find`, which walks directory children in fixed-size pages and stops after collecting the requested page instead of materializing every match.

`exclude` takes globs of the same shape, matched against the same relative path, and beats the inclusion pattern. An excluded directory is pruned rather than filtered, so `exclude: ["node_modules", "node_modules/**"]` keeps the walk out of a package tree instead of walking it and discarding the results.

## `grep`

```ts
{
  path?: string;          // default /workspace
  query: string;
  include?: string;       // glob relative to path
  regex?: boolean;        // default false
  ignoreCase?: boolean;   // default false
  context?: number;       // 0 through 10
  limit?: number;         // default 200, maximum 1000
  offset?: number;
}
```

The AI tool defaults to literal, case-sensitive matching. Set `regex: true` to interpret `query` as a regular expression and `ignoreCase: true` to ignore letter case. Matches include path, line number, text, and optional numbered context. Invalid regular expressions return a structured error. A non-final page includes `nextOffset`.

The tool passes `include`, `limit`, and `offset` through one `workspace.fs.grep` call. The storage search pages matching files and stops after the requested matches, so an included search does not build the full file or match list in the tool layer. Directory searches return matches in deterministic depth-first discovery order, then line order within each file. They are not globally sorted by full path.

The lower-level `workspace.fs.grep` uses the same literal, case-sensitive defaults. Its options also accept `limit`, `offset`, `include`, `context`, `regex`, and `ignoreCase`.

## `write`

```ts
createWriteTool({ store, maxBytes? }); // default 2 MiB
```

The schema is `{ path, content }`. Writing overwrites the file and preserves its existing mode. The tool rejects content over `maxBytes`.

## `edit`

```ts
createEditTool({ store, maxBytes? }); // default 2 MiB
```

The schema is:

```ts
{
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}
```

Every `oldText` must identify one unique, non-overlapping range in the original content. Exact matching is tried first. If that misses, the tool can locate the range after NFKC normalization, trailing-whitespace trimming, and common quote, dash, and space folding. Fuzzy normalization is lookup-only: the replacement is spliced into the original text, so content outside the matched range stays unchanged and the returned diff describes the bytes written. A fuzzy match whose normalized boundary cannot map unambiguously to the source is rejected; copy a larger exact range in that case.

The tool applies the batch atomically, preserves the byte order mark, line ending style, and file mode, and returns a unified patch plus `firstChangedLine`.

`edit`, `write`, and `delete` share locks through the store's stable `lockIdentity`. Every `WorkspaceFileStore` over the same `workspace.fs` uses the same identity, including adapters created by separate `createAITools()` calls. A write cannot land between edit's read and write phases, while unrelated workspaces and paths remain independent. Recursive deletion also locks the whole subtree, so mutations to ancestors or descendants cannot interleave with it.

## `delete`

```ts
{
  path: string;
  recursive?: boolean;
}
```

The tool uses forced removal, so deleting a missing path succeeds. Set `recursive` to remove a non-empty directory. `readonly: true` omits this tool.

## `exec`

`exec` is opt-in. It calls `workspace.runtime.exec` with the configured backend and streams bounded output. Backend descriptions are included in the model-facing tool description, so describe capabilities and startup cost in plain language.

Wire this tool carefully: it executes arbitrary shell commands inside the configured backend. Treat its output as untrusted text when including it in later model input. Omit `shell` or use `readonly: true` when command execution is not part of the agent's job.

## `publish`

`publish` calls `workspace.assets.share`. It appears when assets are configured, `assets` is not `false`, and the tool set is not read-only. The default link expiry is one hour.

## `FileStore`

```ts
interface FileStat {
  size: number;
  mtime: number;
  mode?: number;
}

interface FileStore {
  readonly lockIdentity?: object;
  stat(path: string): Promise<FileStat | null>;
  readAll(path: string): Promise<Uint8Array | null>;
  readChunks(
    path: string,
    byteOffset?: number,
    byteLength?: number,
  ): AsyncIterable<Uint8Array>;
  write(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
}

interface MutableFileStore extends FileStore {
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}
```

`readChunks` must stream without loading the full file at once. It yields no bytes at or beyond end of file; otherwise it yields exactly `min(byteLength ?? size - byteOffset, size - byteOffset)` bytes and throws when the path is missing. `readAll` is the explicit whole-file operation used only where the caller applies its own size bound or needs all content for an edit.

`lockIdentity` coordinates mutations across adapters that represent the same storage resource. Custom stores should share one identity when their instances can reach the same files.

`WorkspaceFileStore` adapts the corresponding `workspace.fs` methods. Its chunk iterator opens one ranged `readFile` stream, so seeking to a byte continuation neither transfers the preceding content nor issues one RPC invocation per chunk.

## Conventions for agents

- Tools take absolute paths. Resolve user input against the configured workspace root before calling them. See [01. VFS](./01_vfs.md).
- The `read` tool returns line and byte continuation offsets. Pass both back on the next call instead of asking for the whole file again.
- Tell the model that each `edit` batch applies against the original file content. Treating each edit as an incremental change can produce overlapping edits, which the tool rejects.
- Describe every shell backend in plain language. The model reads these descriptions when deciding where to run a command.
- Treat `exec` output as untrusted text when including it in later model input.
- Use `readonly: true` for review, indexing, or support agents that should not modify the workspace.
