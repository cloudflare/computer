# 09. Tool interface (agents)

`@cloudflare/workspace/tools` ships ready-made [AI SDK](https://github.com/vercel/ai) tools for agents that use a `Workspace`. The first provider target is the AI SDK because it is the tool layer used by the `agents` SDK and the Think example.

The tools are thin wrappers over the existing `Workspace` surfaces:

- `workspace.fs` for file reads, writes, edits, and directory listing.
- `workspace.shell.exec` for command execution when the caller opts in.
- `workspace.assets` for publishing generated files when an assets publisher is configured.

Git access already ships through `workspace.git`, the third major surface on `Workspace` alongside `fs` and `shell`. AI SDK tool wrappers around that surface can land later against a stable target. See [`13_git_interface.md`](./13_git_interface.md).

## What ships

| Export | Purpose |
| --- | --- |
| `createAITools` | Create the default AI SDK `ToolSet` for a Workspace. |
| `createReadTool` | Memory-efficient, line-windowed file read. |
| `createWriteTool` | Whole-file write with a UTF-8 byte cap. |
| `createEditTool` | Exact targeted replacements with unified-diff preview. |
| `createListTool` | One-level directory listing. |
| `createExecTool` | Run a shell command through a configured Workspace backend. |
| `createPublishTool` | Publish a workspace file through `workspace.assets`. |
| `WorkspaceFileStore` | Adapt `Workspace.fs` to the file-store shape used by the file tools. |

The fixed tool names from `createAITools()` are `read`, `write`, `edit`, and `ls`. When present, the conditional tool names are also fixed: `exec` for shell commands and `publish` for asset publishing.

## Wiring up

```ts
import { Workspace } from "@cloudflare/workspace";
import { createAITools } from "@cloudflare/workspace/tools";

export class Agent {
  workspace: Workspace;

  constructor(ctx: DurableObjectState) {
    this.workspace = new Workspace({
      storage: ctx.storage,
    });
  }

  getTools() {
    return createAITools({
      workspace: this.workspace,
      read: { maxBytes: 32 * 1024, maxLines: 800 },
    });
  }
}
```

When assigning the same instance to `Think.workspace`, construct it with `useThink: true` so Think's built-in workspace tools can use the compatibility filesystem methods. Pass `shell` only when the `Workspace` was constructed with matching backend ids:

```ts
const workspace = new Workspace({
  storage: ctx.storage,
  backends: [
    new WorkerBackend({ id: "shell", /* ... */ }),
    new CloudflareContainerBackend({ id: "container", /* ... */ }),
  ],
});

const tools = createAITools({
  workspace,
  shell: {
    defaultBackend: "shell",
    backends: {
      shell: {
        description: "Fast Worker shell with built-in textual commands.",
      },
      container: {
        description: "Full Linux userland in a Cloudflare Container.",
      },
    },
  },
});
```

The returned value is an AI SDK `ToolSet`. Pass it to `generateText`, `streamText`, or an agent framework hook such as `getTools()`.

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
| `workspace` | required | A `Workspace` or structural equivalent with `fs`, and optionally `shell`, `assets`, and `sessionId`. |
| `readonly` | `false` | When true, return only `read` and `ls`. This omits mutation tools, `exec`, and `publish` even if other options are present. |
| `assets` | `true` | Set to `false` to omit `publish`. When not false, `publish` appears only if `workspace.assets` is configured. |
| `read` | default caps | Options passed to `createReadTool`. |
| `write` | default caps | Options passed to `createWriteTool`. Ignored when `readonly` is true. |
| `edit` | default caps | Options passed to `createEditTool`. Ignored when `readonly` is true. |
| `shell` | omitted | Options passed to `createExecTool`. `exec` appears only when this is present and `readonly` is not true. |

`createAITools({ workspace, readonly: true })` is the safe mode for agents that should inspect a workspace but not change it or run commands.

## `read`

```ts
createReadTool({ store, maxLines?, maxBytes? });
```

| Option | Default | Notes |
| --- | --- | --- |
| `maxLines` | 2000 | Hard line cap per call. |
| `maxBytes` | 256 KiB | Hard byte cap per call. |

Schema:

```ts
{
  path: string;
  offset?: number; // 1-indexed start line
  limit?: number;  // max lines this call
}
```

Returns the line window plus `nextOffset` whenever the result was truncated, so the model can call `read` again to keep going. Reads stream through `store.readChunks(path)` and stop as soon as the line or byte cap is hit.

## `ls`

```ts
createListTool({ workspace });
```

Schema:

```ts
{
  path: string;
}
```

Calls `workspace.fs.readdir(path)` and returns:

```ts
{
  path: string;
  entries: Array<{
    name: string;
    isFile: boolean;
    isDirectory: boolean;
  }>;
}
```

## `write`

```ts
createWriteTool({ store, maxBytes? });
```

| Option | Default |
| --- | --- |
| `maxBytes` | 2 MiB |

Schema:

```ts
{
  path: string;
  content: string;
}
```

Overwrites the file. Preserves an existing file's `mode` so executable scripts keep their executable bit. Rejects writes larger than `maxBytes` with a structured error pointing the model at the `edit` tool or a smaller write.

## `edit`

```ts
createEditTool({ store, maxBytes? });
```

| Option | Default |
| --- | --- |
| `maxBytes` | 2 MiB |

Schema:

```ts
{
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}
```

Each edit is matched against the original file content, not incrementally. Overlapping or nested edits are rejected. The tool normalizes line endings for matching, restores the original line ending style on write, preserves the existing file mode, and returns a unified patch for review.

## `exec`

```ts
createExecTool({
  workspace,
  backends,
  defaultBackend,
  maxBytes?,
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `backends` | required | Map of backend id to a model-facing description. |
| `defaultBackend` | required | Backend used when the model omits `backend`. Must be a key in `backends`. |
| `maxBytes` | 64 KiB | UTF-8 byte cap for each of stdout and stderr. |

Schema:

```ts
{
  command: string;
  cwd?: string;
  backend?: string;
}
```

Calls `workspace.shell.exec(command, { cwd, encoding: "utf8", backend })`, waits for `result()`, and returns:

```ts
{
  command: string;
  cwd: string | null;
  backend: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}
```

`exec` is opt-in. `createAITools()` includes it only when the caller passes `shell` options and `readonly` is not true. The backend descriptions are included in the tool description so the model can choose the cheapest backend that can run the command.

Wire this tool up carefully: it executes arbitrary shell commands inside the configured backend. Use `readonly: true` for inspection-only agents, or omit `shell` when command execution is not part of the agent's job.

## `publish`

```ts
createPublishTool({ workspace });
```

Schema:

```ts
{
  path: string;
  expiresAfterMs?: number;
}
```

Calls `workspace.assets.share(path, { expiresAfter, prefix })` and returns either:

```ts
{ ok: true; url: string }
```

or:

```ts
{ ok: false; error: string }
```

The default expiry is one hour. When `workspace.sessionId` is non-empty, the prefix is `agent-${workspace.sessionId}` so generated links are grouped by workspace session. If no session id was configured, the tool leaves the prefix unset.

`createAITools()` includes `publish` by default when `readonly` is not true, `assets` is not false, and `workspace.assets` is configured. Pass `assets: false` to hide the tool even when credentials are present.

## `FileStore`

The file tools depend on this shape:

```ts
interface FileStore {
  stat(path: string): Promise<FileStat | null>;
  readAll(path: string): Promise<Uint8Array | null>;
  readChunks(path: string, byteOffset?: number, byteLength?: number): AsyncIterable<Uint8Array>;
  write(path: string, bytes: Uint8Array, options?: { mode?: number }): Promise<void>;
}

interface FileStat {
  size: number;
  mode?: number;
  mtime: number;
}
```

`WorkspaceFileStore` adapts `Workspace.fs.stat`, `Workspace.fs.readFile`, `Workspace.fs.writeFile`, and `Workspace.fs.mkdir` to this contract. Custom stores can use the same tools against another filesystem-shaped backend.

## Conventions for agents

- Tools take absolute paths. Pre-resolve user input against the configured workspace root before calling. See [01. VFS](./01_vfs.md).
- The `read` tool returns continuation offsets. Feed them back to the model on truncation rather than asking for the whole file.
- Pair the `edit` tool with a system prompt that says edits apply against the original file. Models that incrementally update their mental model of the file will produce overlapping edits and get a rejection error.
- Describe every shell backend in plain language. The model reads those descriptions when deciding where a command should run.
- Treat `exec` output as untrusted text when feeding it back into the model.
- Use `readonly: true` for review, indexing, or support agents that should not modify the workspace.
