# 09. Tool interface (agents)

Computer ships a ready-made tool set for agents that use a `Workspace`, once for each of three agent libraries:

| Library | Entry point | Factory |
| --- | --- | --- |
| [AI SDK](https://github.com/vercel/ai) (`ai`) | `@cloudflare/computer/tools` | `createAITools` |
| [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`) | `@cloudflare/computer/tools/pi-ai` | `createPiTools` |
| [TanStack AI](https://tanstack.com/ai) (`@tanstack/ai`) | `@cloudflare/computer/tools/tanstack-ai` | `createTanStackTools` |

All three take the same options and build the same tools, with the same names, descriptions, schemas, and limits. Only the shape they return differs. Each entry point imports only `zod` and its own library's types, so a pi agent never loads `ai` and an AI SDK agent never loads pi. The individual AI SDK `create*Tool` functions and `WorkspaceFileStore` also come from `@cloudflare/computer/tools`.

The tools wrap three Workspace surfaces:

- `workspace.fs` for file reads, writes, edits, searches, listings, and deletion;
- `workspace.runtime.exec` for command execution when the caller opts in;
- `workspace.assets` for publishing generated files when an assets publisher is configured.

## What ships

| Export | Purpose |
| --- | --- |
| `createAITools` | Create the default AI SDK `ToolSet` for a Workspace. |
| `createPiTools` | Create pi tool declarations and the function that runs a pi tool call. |
| `createTanStackTools` | Create the TanStack AI tool list for a Workspace. |
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

Every tool set names its tools `read`, `ls`, `find`, `grep`, `write`, `edit`, and `delete`. `exec` appears when the caller supplies `shell` options. `publish` appears when assets are configured. In read-only mode the set is `read`, `ls`, `find`, and `grep`.

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

`createPiTools` and `createTanStackTools` take `shell` the same way.

## pi

pi keeps tool declarations apart from the code that runs them. `Context.tools` carries declarations with JSON Schema `parameters`, and the caller's own loop runs each call. `createPiTools` returns both, so they cannot drift apart.

```ts
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";

const { tools, execute } = createPiTools({ workspace });

const message = await models.complete(model, { systemPrompt, messages, tools });
messages.push(message);

for (const block of message.content) {
  if (block.type !== "toolCall") continue;
  const { content, isError } = await execute(block);
  messages.push({
    role: "toolResult",
    toolCallId: block.id,
    toolName: block.name,
    content,
    isError,
    timestamp: Date.now(),
  });
}
```

`execute` checks the call's arguments against the tool's schema and returns pi `toolResult` content. A bad call or a failed tool comes back as `isError: true`, so the model can retry and the loop does not throw. pi describes tool parameters with TypeBox, which also accepts plain JSON Schema, so the Zod schemas are converted to JSON Schema and pi needs nothing else. A field with a default stays optional for the model.

`read`, `write`, and `edit` carry byte offsets and long verbatim strings, so they ask for pi's `constrainedSampling`. A provider that supports it enforces the schema while sampling, and a malformed `edit` never reaches the tool. The declarations stay open. pi closes a schema itself when the provider supports strict mode, making every field required and the optional ones nullable. `execute` drops a null on an optional field that does not accept one, and keeps a null the tool accepts, such as `exec`'s `input`.

The default is `"prefer"`, which falls back to ordinary tool calling on a provider that cannot enforce a schema. `"require"` fails the request instead, for a pinned model known to support it. `false` turns it off and keeps the schemas open:

```ts
createPiTools({ workspace, constrainedSampling: "require" });
```

pi tool results carry text and images. An image from `read` comes back as an `image` block; a PDF comes back as text saying it cannot be attached. `exec` returns its final snapshot.

## TanStack AI

A TanStack tool's `inputSchema` is a Standard Schema, which Zod implements, so the schemas pass through unchanged. The tools come back as a list, the shape `chat({ tools })`, `mergeAgentTools`, and `createToolRegistry` take. `format: "object"` keys them by name instead, for reaching one tool directly.

```ts
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import { createTanStackTools } from "@cloudflare/computer/tools/tanstack-ai";

const abortController = new AbortController();
const tools = createTanStackTools({ workspace, approve: "mutating" });

return toServerSentEventsResponse(chat({ adapter, messages, tools, abortController }));
```

| Option | Default | Notes |
| --- | --- | --- |
| `format` | `"array"` | `"object"` keys the tools by name. |
| `approve` | none | Tool names that pause for TanStack's `needsApproval`, or `"mutating"` for every tool that changes the Workspace. |
| `lazy` | none | Tool names, or `"all"`, to withhold from the prompt until TanStack's lazy discovery asks for them. |
| `streamEventName` | none | Forward each running `exec` snapshot through `emitCustomEvent` under this name. |

`write`, `edit`, `delete`, and `publish` have one fixed result shape, so they also carry an `outputSchema`. It covers failures too, because TanStack validates every return against it, and a success-only schema would replace the real error with a validation complaint. Paged tools such as `ls` have none.

An image or PDF from `read` comes back as a text part plus an `image` or `document` content part, the array shape `chat()` passes to the adapter as multimodal content instead of stringifying it.

Aborting the chat run through its `abortController` kills a running `exec`. A TanStack tool settles on one value, so `exec` returns its final snapshot.

## Options

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

`createPiTools` and `createTanStackTools` take the same options, plus their own listed above.

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
  exclude?: string[];     // globs pruned from the walk
  regex?: boolean;        // default false
  ignoreCase?: boolean;   // default false
  context?: number;       // 0 through 10
  limit?: number;         // default 200, maximum 1000
  offset?: number;
}
```

The AI tool defaults to literal, case-sensitive matching. Set `regex: true` to interpret `query` as a regular expression and `ignoreCase: true` to ignore letter case. Matches include path, line number, text, and optional numbered context. Invalid regular expressions return a structured error. A non-final page includes `nextOffset`.

`exclude` works exactly as it does on `find`: globs of the same shape, matched against the same relative path, applied before `include` so an exclusion always wins. An excluded directory is pruned before its children are queried rather than being read and filtered, so `exclude: ["node_modules", "node_modules/**"]` keeps the search out of a package tree. Name both forms, since `node_modules/**` matches what is below the directory rather than the directory itself. A single-file search has no traversal to prune, so `exclude` does not apply to it.

The tool passes `include`, `exclude`, `limit`, and `offset` through one `workspace.fs.grep` call. The storage search pages matching files and stops after the requested matches, so an included search does not build the full file or match list in the tool layer. Directory searches return matches in deterministic depth-first discovery order, then line order within each file. They are not globally sorted by full path.

The lower-level `workspace.fs.grep` uses the same literal, case-sensitive defaults. Its options also accept `limit`, `offset`, `include`, `exclude`, `context`, `regex`, and `ignoreCase`.

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
