# 09. Tool interface (agents)

`@cloudflare/computer/tools` ships ready-made [AI SDK](https://github.com/vercel/ai) tools for agents that use a `Workspace`.

The tools wrap three Workspace surfaces:

- `workspace.fs` for file reads, writes, edits, searches, listings, and deletion;
- `workspace.runtime.exec` for command execution when the caller opts in;
- `workspace.assets` for publishing generated files when an assets publisher is configured.

## What ships

| Export | Purpose |
| --- | --- |
| `createAITools` | Create the default AI SDK `ToolSet` for a Workspace. |
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

`createAITools()` always names its tools `read`, `ls`, `find`, `grep`, `write`, `edit`, and `delete`. `exec` appears when the caller supplies `shell` options. `publish` appears when assets are configured. In read-only mode the set is `read`, `ls`, `find`, and `grep`.

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

## `createAITools`

```ts
createAITools({
  workspace,
  readonly?,
  assets?,
  read?,
  write?,
  edit?,
  find?,
  grep?,
  delete?,
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
| `find`, `grep`, `delete` | omitted | Reserved option bags with no configurable fields yet. |
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

A truncated text result has `totalLines: null`, `nextOffset`, and `nextByteOffset`. Pass both continuations to the next call. `nextOffset` preserves line numbering; `nextByteOffset` prevents the store from transferring bytes already read. The AI SDK model output keeps this complete result as JSON when a read is truncated. A complete read remains plain text.

Known image and PDF extensions are classified without reading the file. Unknown extensions use a bounded magic-byte sniff. The tool's `toModelOutput` hook emits AI SDK `file-data` parts for images and PDFs. It checks the file size, then reads at most `maxModelBytes + 1` bytes before deciding whether to encode the file. This keeps the load bounded if the file grows after the size check. Other binary files return an unsupported binary result.

## `ls`

```ts
{
  path: string;
  limit?: number;  // default 200, maximum 1000
  offset?: number;
}
```

`ls` returns at most `limit` entries in name order. Each entry includes `name`, `size`, `mtime`, `isFile`, `isDirectory`, and `isSymbolicLink`. A non-final page includes `nextOffset`.

## `find`

```ts
{
  path?: string;   // default /workspace
  pattern: string;
  limit?: number;  // default 200, maximum 1000
  offset?: number;
}
```

The pattern is relative to `path`. `*` stays within one path segment, `**` crosses directories, and `?` matches one non-separator character. Results contain `path` and `type`; a non-final page includes `nextOffset`. Pagination reaches `workspace.fs.find`, which walks directory children in fixed-size pages and stops after collecting the requested page instead of materializing every match.

## `grep`

```ts
{
  path?: string;          // default /workspace
  query: string;
  include?: string;       // glob relative to path
  fixedString?: boolean;  // default false
  caseSensitive?: boolean;// default false
  contextLines?: number;  // 0 through 10
  limit?: number;         // default 200, maximum 1000
  offset?: number;
}
```

The AI tool defaults to case-insensitive regular expressions to match Think's tool contract. Set `fixedString` when the query should be treated as plain text. Matches include path, line number, text, and optional numbered context. Invalid regular expressions return a structured error. A non-final page includes `nextOffset`.

The tool passes `include`, `limit`, and `offset` through one `workspace.fs.grep` call. The storage search pages matching files and stops after the requested matches, so an included search does not build the full file or match list in the tool layer. Directory searches return matches in deterministic depth-first discovery order, then line order within each file. They are not globally sorted by full path.

The lower-level `workspace.fs.grep` keeps its existing defaults: literal and case-sensitive. Its options also accept `limit`, `offset`, `include`, `contextLines`, `fixedString`, and `caseSensitive`.

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

Every `oldText` must identify one unique, non-overlapping range in the original content. The tool applies the batch atomically, preserves the byte order mark, line ending style, and file mode, and returns a unified patch plus `firstChangedLine`.

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

`WorkspaceFileStore` adapts the corresponding `workspace.fs` methods. Its chunk iterator uses fixed-size `readRange` calls, so seeking to a byte continuation does not stream and discard the preceding file content.

## Conventions for agents

- Tools take absolute paths. Resolve user input against the configured workspace root before calling them. See [01. VFS](./01_vfs.md).
- The `read` tool returns line and byte continuation offsets. Pass both back on the next call instead of asking for the whole file again.
- Tell the model that each `edit` batch applies against the original file content. Treating each edit as an incremental change can produce overlapping edits, which the tool rejects.
- Describe every shell backend in plain language. The model reads these descriptions when deciding where to run a command.
- Treat `exec` output as untrusted text when including it in later model input.
- Use `readonly: true` for review, indexing, or support agents that should not modify the workspace.
