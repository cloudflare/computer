# 04. Filesystem Interface

> [!NOTE]
> This document describes the public `Workspace.fs` surface and is kept
> in step with the code in `@cloudflare/dofs`. A few spots are
> explicitly flagged where the doc reflects an intended target (true
> streaming `writeFile`, mount-layer error codes); everything else is
> what ships today.

`Workspace.fs` is the file API. It's inspired by `node:fs/promises` for
familiarity — same method names, similar option shapes — but it's a much
smaller surface and it leans on `ReadableStream<Uint8Array>` wherever a
file could be large.

```ts
interface Workspace {
  fs:    WorkspaceFilesystem;
  runtime: WorkspaceRuntime;    // see 05_runtime_interface.md
}
```

Three things to keep in mind when porting Node code over:

- Every method is **async**, even ones Node ships as sync-only.
- Paths are **absolute** and POSIX-style (see
  [01. VFS](./01_vfs.md)).
- The default `readFile` return is a **stream**, not a Buffer. Pass
  `"utf8"` (or `{ encoding: "utf8" }`) when you actually want a string in
  memory. Use streams whenever the file could be larger than a few
  hundred KB — they pipe directly into `Response`, `fetch`, R2 `put`,
  and any other `ReadableStream` consumer without buffering.

See the [appendix](#appendix-comparison-with-nodefspromises) for a
method-by-method mapping against `node:fs/promises`.
## API

### `readFile`

```ts
type ReadFileRange = {
  byteOffset?: number; // default 0
  byteLength?: number; // default: remainder of the file
};

readFile(path: string): Promise<ReadableStream<Uint8Array>>
readFile(path: string, encoding: "utf8"): Promise<string>
readFile(path: string, options: ReadFileRange): Promise<ReadableStream<Uint8Array>>
readFile(
  path: string,
  options: ReadFileRange & { encoding: "utf8" },
): Promise<string>
```

Defaulting to a stream is deliberate — most reads in an agent context
are "send this file somewhere" and never need to be in memory. A ranged
stream resolves the file and captures its overlapping chunk rows once,
then lazily sends those content-addressed blobs. This preserves the existing
whole-file stream behavior across ordinary concurrent writes while avoiding
reads before `byteOffset`. The same single stream
crosses the Workers RPC boundary; callers do not issue one RPC invocation
per storage chunk.

```ts
// Stream a large file straight to the client.
const stream = await fs.readFile("/workspace/build/out.wasm");
return new Response(stream, { headers: { "content-type": "application/wasm" } });

// Resume a stream at a byte continuation and cap the transfer.
const continuation = await fs.readFile("/workspace/build/out.wasm", {
  byteOffset: 1_048_576,
  byteLength: 262_144,
});

// Read a small text file into a string.
const todo = await fs.readFile("/workspace/notes/todo.md", "utf8");

// The verbose form, for symmetry with node:fs/promises.
const config = await fs.readFile("/workspace/config.json", { encoding: "utf8" });
```

### `writeFile`

```ts
writeFile(
  path:    string,
  content: string | Uint8Array | ReadableStream<Uint8Array>,
  options?: { mode?: number }
): Promise<void>
```

Accepts a stream so callers can supply uploads, R2 bodies, and `fetch`
responses without an intermediate `arrayBuffer()`. Stream sources are
consumed incrementally: bytes are re-windowed into fixed `CHUNK_SIZE`
(512 KiB) pieces, hashed, and staged into `vfs_blobs` as they arrive,
so peak memory is bounded by one chunk plus whatever the source
yields per pull — not the full file. The inode, dirent, chunk-list,
and manifest rows are committed in one short transaction once the
source drains; a mid-stream failure leaves orphan blob rows that
`gc()` reaps on its next pass.

```ts
// Text.
await fs.writeFile("/workspace/notes/todo.md", "- [ ] ship it\n");

// Binary.
await fs.writeFile("/workspace/data/blob.bin", new Uint8Array([1, 2, 3]));

// Supply an HTTP upload as a stream (consumed incrementally).
await fs.writeFile("/workspace/uploads/big.csv", request.body!);

// Pipe an R2 object into the workspace.
const obj = await env.BUCKET.get("imports/data.parquet");
if (obj) await fs.writeFile("/workspace/imports/data.parquet", obj.body);

// Mark a script executable.
await fs.writeFile("/workspace/bin/run.sh", "#!/bin/sh\necho hi\n", { mode: 0o755 });
```

### `rm`

```ts
rm(path: string, options?: { recursive?: true; force?: true }): Promise<void>
```

Replaces both `unlink` and `rmdir`. Pass `recursive: true` for non-empty
directories; `force: true` silences `ENOENT`.

> The `recursive?: true` / `force?: true` literal types are intentional
> today and reject `false`. Widening to `boolean` for `node:fs/promises`
> parity is a deferred follow-up.

```ts
// Single file.
await fs.rm("/workspace/notes/todo.md");

// Recursive directory wipe.
await fs.rm("/workspace/build", { recursive: true });

// Idempotent cleanup.
await fs.rm("/workspace/cache", { recursive: true, force: true });
```

### `mkdir`

```ts
mkdir(path: string, options?: { recursive?: true; mode?: number }): Promise<void>
```

Same literal-`true` caveat as `rm` — see the note above.

```ts
await fs.mkdir("/workspace/notes");
await fs.mkdir("/workspace/projects/a/b/c", { recursive: true });
```

### `readdir`

```ts
readdir(path: string): Promise<Array<{
  name:        string;
  parentPath:  string;
  isFile:      boolean;
  isDirectory: boolean;
}>>
```

Returns dirent-shaped entries by default so you don't need a follow-up
`stat()` to tell files from directories.

```ts
for (const entry of await fs.readdir("/workspace/notes")) {
  if (entry.isDirectory) console.log(`d ${entry.name}/`);
  else                   console.log(`f ${entry.name}`);
}
```

### `stat`

```ts
stat(path: string): Promise<{
  name:        string;
  mode:        number;
  mtime:       number;   // ms since epoch
  size:        number;
  isFile:      boolean;
  isDirectory: boolean;
}>
```

`name` is the last segment of the canonicalized path. For the workspace
root this is the empty string: `(await fs.stat("/")).name === ""`.

`stat` follows a trailing symbolic link, so it reports the file or
directory the link points at. Use [`lstat`](#lstat) to inspect the link
itself. A dangling link makes `stat` report `ENOENT` while `lstat`
succeeds.

> When a parent path segment is itself a file, `stat` reports `ENOENT`
> (because resolution returns `null` for that case) rather than
> `ENOTDIR`. `mkdir` and `writeFile` raise `ENOTDIR` explicitly for the
> same shape — see the error table.

```ts
const s = await fs.stat("/workspace/build/out.wasm");
console.log(`${s.size} bytes, modified ${new Date(s.mtime).toISOString()}`);
```

### `lstat`

```ts
lstat(path: string): Promise<{
  name:            string;
  mode:            number;
  mtime:           number;   // ms since epoch
  size:            number;
  isFile:          boolean;
  isDirectory:     boolean;
  isSymbolicLink:  boolean;
}>
```

Same shape as `stat`, but a trailing symbolic link is reported as the
link rather than followed. `size` is then the byte length of the stored
target string, and `isSymbolicLink` is true. Intermediate segments are
still followed, so a link in the middle of the path resolves as usual.
Throws `ENOENT` when the path does not exist and `ELOOP` when an
intermediate chain exceeds 40 hops.

```ts
await fs.symlink("/workspace/real.txt", "/workspace/alias.txt");
(await fs.stat("/workspace/alias.txt")).isSymbolicLink;   // false
(await fs.lstat("/workspace/alias.txt")).isSymbolicLink;  // true
```

### `symlink`

```ts
symlink(target: string, path: string): Promise<void>
```

Creates a symbolic link at `path` pointing at `target`, with the
argument order of `node:fs/promises`. The target is stored verbatim: it
may be absolute or relative, and it is allowed to dangle. Reads and
writes that walk through the link follow it, with the same 40-hop cap as
every other resolution.

Throws `EEXIST` when `path` already exists (the link is never replaced
silently), `ENOENT` when the parent directory is missing, `ENOTDIR` when
a parent segment is a file, and `EROFS` under a read-only mount.

```ts
await fs.symlink("../shared/config.json", "/workspace/app/config.json");
```

### `readlink`

```ts
readlink(path: string): Promise<string>
```

Returns the stored target of a symbolic link, exactly as it was
written — relative targets are not resolved. Throws `EINVAL` when `path`
is not a symbolic link and `ENOENT` when it does not exist.

```ts
await fs.readlink("/workspace/app/config.json"); // "../shared/config.json"
```

### `chmod`

```ts
chmod(path: string, mode: number): Promise<void>
```

Changes the permission bits of an existing path without rewriting its
bytes. The mode is masked to twelve bits. Like POSIX `chmod`, a trailing
symbolic link is followed, so the change lands on the target rather than
the link. Throws `ENOENT` for a missing path and `EROFS` under a
read-only mount.

```ts
await fs.chmod("/workspace/bin/run.sh", 0o755);
```

### `rename`

```ts
rename(oldPath: string, newPath: string): Promise<void>
```

Moves a file, directory, or symbolic link in a single transaction, so an
interrupted call can never leave the entry at both paths or a directory
partly copied. The moved entry keeps its inode, its bytes, and its mode;
a directory move carries its whole subtree.

Overwrite behavior follows POSIX `rename(2)`: an existing destination is
replaced when the two ends agree on kind. A file or symbolic link
replaces a file or symbolic link, and a directory replaces an *empty*
directory. Nothing else is replaced.

| Code | When |
| --- | --- |
| `ENOENT` | `oldPath` does not exist, or `newPath`'s parent directory is missing. |
| `ENOTEMPTY` | `newPath` is a directory with children. |
| `EISDIR` | `newPath` is a directory and `oldPath` is not. |
| `ENOTDIR` | `oldPath` is a directory and `newPath` is not. |
| `EINVAL` | Either end is the root, or a directory would be moved inside itself. |
| `EROFS` | Either end falls under a read-only mount. |

```ts
// Publish a build atomically.
await fs.writeFile("/workspace/site/index.html.tmp", html);
await fs.rename("/workspace/site/index.html.tmp", "/workspace/site/index.html");

// Move a whole tree.
await fs.rename("/workspace/draft", "/workspace/published");
```

### `find`

```ts
find(
  directory: string,
  pattern?: string,            // simple glob (`*.ts`, `**/*.md`)
  options?: {
    limit?: number;
    offset?: number;
    exclude?: string[];
  },
): Promise<Array<{ path; type: "file" | "dir" }>>
```

Resolves `directory` first: throws `ENOENT` if the directory does not
exist and `ENOTDIR` if `directory` points at a file. The glob is
matched against each candidate's path **relative to `directory`**, not
its absolute path — so `**/*.ts` under `/workspace/src` matches
`a/b.ts`, not `/workspace/src/a/b.ts`.

The glob supports `*`, `**`, `**/`, and `?`. Character classes and
brace expansions are matched literally.

`exclude` takes globs of the same shape, matched against the same
relative path. An exclusion is decided before the inclusion glob, so it
always wins. When an excluded entry is a directory the walk prunes it:
neither the directory nor anything beneath it is read, which is what
makes skipping `node_modules` or `.git` cheap rather than merely quiet.
`limit` and `offset` then paginate whatever survives.

```ts
// Every TypeScript file in the project.
const ts = await fs.find("/workspace/src", "**/*.ts");

// Everything under a directory (no pattern).
const all = await fs.find("/workspace/notes");

// Skip generated trees without descending into them.
const sources = await fs.find("/workspace", "**/*.ts", {
  exclude: ["node_modules", "node_modules/**", ".git", ".git/**"],
});
```

### `ls`

```ts
ls(prefix: string): Promise<string[]>
```

Flat list of every file at or under `prefix`. The match is
**segment-aware**, not pure string-prefix: `ls("/workspace/notes")`
returns the file `/workspace/notes` (if it is a file) and every file
under `/workspace/notes/…`, but never `/workspace/notes-archive/x`.

Cheaper than `find` when you don't need the directory rows.

`ls` does **not** validate the prefix — a missing path returns `[]`
silently rather than throwing `ENOENT`. Use `stat` first if you need to
distinguish "empty directory" from "no such directory".

```ts
const paths = await fs.ls("/workspace/.agents/skills");
```

### `grep`

`Workspace.fs.grep` accepts this interface:

```ts
interface GrepOptions {
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
  include?: string;
}

interface WorkspaceGrepContextLine {
  line: number;
  text: string;
  isMatch: boolean;
}

interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
  context?: WorkspaceGrepContextLine[];
}

grep(
  pattern: string,
  path: string,
  options?: GrepOptions,
): Promise<WorkspaceGrepMatch[]>
```

Matching is literal and case-sensitive by default. Set `regex: true` to
interpret `pattern` as a regular expression and `ignoreCase: true` to ignore
letter case. `context` adds that many lines before and after each match.
`include` is a glob relative to a searched directory. `limit` and `offset`
paginate matching lines.

`path` may be a directory or a single file. Directory searches return matches
in deterministic depth-first discovery order, then line order within each
file. Results are not globally sorted by full path.

```ts
const hits = await fs.grep("TODO", "/workspace/src", {
  ignoreCase: true,
  include: "**/*.ts",
});
for (const hit of hits) {
  console.log(`${hit.path}:${hit.line}: ${hit.text}`);
}
```

`Workspace.runtime` exposes a narrower container-side variant that accepts only
`ignoreCase` and treats its pattern as a literal string. See
[05. Shell Interface](./05_runtime_interface.md) for that variant.

## Error handling

Errors thrown by `fs` are POSIX-style — a `NodeJS.ErrnoException`-shaped
object with a `code` property (and a `path` property where it applies) —
so handlers from Node code port over directly.

| Code | When |
| --- | --- |
| `ENOENT` | Path does not exist and `force` is not true. Also raised by `stat` when a parent segment turns out to be a file. |
| `ENOTEMPTY` | Path is a non-empty directory and `recursive` is not true. Also raised by `rename` when the destination directory has children. |
| `ENOTDIR` | A parent path segment is a file (raised explicitly by `mkdir` and `writeFile`; `find` raises it when its `directory` argument is a file; `rename` raises it when a directory would replace a non-directory). |
| `EISDIR` | Expected a file, got a directory (e.g. `readFile` on a dir, `writeFile` on `/`, `rename` of a file onto a directory). |
| `EEXIST` | `mkdir` without `recursive: true` on an existing path, or `symlink` onto an existing path. |
| `EINVAL` | Invalid path or unsupported options: `readlink` on something that is not a symbolic link, `rename` of the root or of a directory into itself. |
| `ELOOP` | Symbolic-link traversal exceeded 40 hops. Every path-walking method shares that budget, so a cycle surfaces from `stat`, `readFile`, `writeFile`, `mkdir`, and the rest alike. |
| `EPERM` | Operation is forbidden, e.g. deleting the workspace root. |
| `EIO` | Backing storage failed unexpectedly. |
| `EACCES` | *Reserved for future mount layer (see [06. Mount Interface](./06_mount_interface.md)).* No code path in `workspace-fs` currently throws it. |
| `EROFS` | *Reserved for future mount layer (see [06. Mount Interface](./06_mount_interface.md)).* No code path in `workspace-fs` currently throws it. |

### Example: handle "file missing" and bubble everything else

```ts
async function readConfig(): Promise<Config> {
  try {
    const text = await this.workspace.fs.readFile("/workspace/config.json", "utf8");
    return JSON.parse(text) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // First boot: seed a default config and return it.
      const seed: Config = { version: 1, theme: "dark" };
      await this.workspace.fs.writeFile(
        "/workspace/config.json",
        JSON.stringify(seed, null, 2),
      );
      return seed;
    }
    // Anything else (EIO, ...) is a real problem — let it surface so
    // the agent's outer error handler logs it and the request fails
    // loudly.
    throw err;
  }
}
```

### Example: idempotent cleanup

```ts
// Equivalent to `rm -rf` — never throws on missing paths.
await this.workspace.fs.rm("/workspace/build", { recursive: true, force: true });
```

## Appendix: comparison with `node:fs/promises`

For reference, here's the public surface of `node:fs/promises` and how it
maps to `Workspace.fs`:

| `node:fs/promises` | `Workspace.fs` | Notes |
| --- | --- | --- |
| `readFile` | `readFile` | Stream by default; pass `"utf8"` for a string. |
| `writeFile` | `writeFile` | Accepts `string`, `Uint8Array`, or `ReadableStream` (consumed incrementally). |
| `appendFile` | — | Read, concat, write. Not a primitive. |
| `mkdir` | `mkdir` | `{ recursive: true }` supported. |
| `rmdir` | `rm` | One method for files and dirs (matches modern Node). |
| `rm` | `rm` | `{ recursive: true }` for non-empty dirs. |
| `unlink` | `rm` | Same. |
| `readdir` | `readdir` | Always returns dirent-shaped entries. |
| `stat` / `lstat` | `stat` / `lstat` | `stat` follows a trailing symbolic link; `lstat` reports the link. |
| `truncate` | — | Read, slice, write. |
| `chmod` | `chmod` | Mode masked to twelve bits; follows a trailing symbolic link. `mode` can also be passed to `writeFile` / `mkdir` at create time. |
| `chown` | — | No ownership model. |
| `utimes` | — | `mtime` is managed by the VFS. |
| `cp` / `copyFile` | — | Read + write. |
| `rename` | `rename` | One transaction; replaces a destination of the same kind. |
| `realpath` | — | Paths are already canonical. |
| `symlink` / `readlink` | `symlink` / `readlink` | Same argument order as Node. Targets are stored verbatim and may dangle. |
| `watch` | — | Low-level primitive in `fs/watch.ts` (`createWatcher`, `createWatchAsyncIterable`, `WatchHandle`, `WatchOptions`); not exposed on the `WorkspaceFilesystem` class. |
| `open` / `FileHandle` | — | Use streams instead. |
| `glob` | `find` | Limited glob support (`*`, `**`, `**/`, and `?`), plus `exclude` for pruning subtrees. |
| — | `grep` | Not in `node:fs`; literal by default, with optional regular expressions. |
| — | `find` | Recursive directory walk with an optional glob, relative-rooted. |
| — | `ls` | Flat list of file paths under a directory (segment-aware). |

### Note: symbolic links

Symbolic links are part of the public surface. The schema carries a
`'symlink'` node type with a `link_target`, the resolver in
`fs/resolve.ts` follows them with a 40-hop cap (throws `ELOOP` on
overflow), and `Workspace.fs` exposes `symlink`, `readlink`, and
`lstat` on top of that. `WorkspaceFilesystemStub` mirrors all three
across the Workers RPC boundary, which is how the Dynamic Worker
filesystem adapters provide the `node:fs` behavior a shell expects from
`ln -s`, `readlink`, and `test -L`.

Two rules cover the whole surface. Intermediate segments are always
followed, so a link to a directory behaves like the directory for every
method, `mkdir` included. A trailing link is followed by everything
except `lstat` and `readlink`, which are the two methods whose purpose
is to describe the link itself.
