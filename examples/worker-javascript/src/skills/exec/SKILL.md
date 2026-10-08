---
name: exec
description: How exec works in this workspace. The command is the source of an ECMAScript module, evaluated in a fresh Dynamic Worker, not a shell command. Read this before running code, and when a run fails with "Disallowed operation called within global scope" or returns nothing.
---

# Running code

Every `exec` call takes **JavaScript module source**, not a shell
command. The durable object builds a module graph from it, starts a
fresh Dynamic Worker, and evaluates the module there. Nothing is shared
between calls.

## The shape of a module

Put the work inside the default export, and return what you want back:

```js
import { readdir, readFile } from "node:fs/promises";

export default async function (input) {
  const names = await readdir(input.dir);
  const first = await readFile(`${input.dir}/${names[0]}`, "utf8");
  return { count: names.length, first };
}
```

- The default export gets the call's `input` value.
- Its return value comes back as the result's `value`. It must be
  JSON-compatible.
- `console.log` and `console.info` go to standard output.
  `console.warn` and `console.error` go to standard error.
- A thrown error ends the run with a non-zero exit code and the message
  on standard error.
- Code at the top level runs before the call is set up. A file read or a
  `fetch` there fails with `Disallowed operation called within global
  scope`. Imports at the top are fine.

## What code can import

- `node:fs/promises` (also `node:fs`): the workspace's files. The
  supported calls are `readFile`, `writeFile`, `mkdir`, `rm`, `readdir`,
  `stat`, `lstat`, `readlink`, `symlink`, `chmod` and `access`. All of
  them are async.
- Relative imports resolve from `cwd` in the workspace, so you can write
  a helper module with one call and import it in the next.
- There is no `node_modules` lookup and no npm. Only the modules above,
  and any the host configures, are available.

## Limits

- No direct network access. `fetch` to the internet fails.
- Each run has a time limit: one minute by default, three at most.
- Source, `input` and the returned value are capped at 1 MiB each.

## Files

- `cwd` defaults to `/workspace`.
- File operations go straight to the durable object's storage. There's
  nothing to sync, so a write is visible to the next call right away.
- `/workspace/r2` is a read-only copy of an R2 bucket.
- `/workspace/.agents/skills` (where this file lives) is a read-only
  copy of files shipped with the Worker. Writing under either one fails
  with `EROFS`.
