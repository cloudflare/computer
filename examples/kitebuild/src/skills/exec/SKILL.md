---
name: exec
description: How exec works in this workspace. Commands run in a BusyBox Linux userland in the durable object, not on a full Linux machine. Read this before running a command, and when a command is "not found" or behaves differently from a usual Linux shell.
---

# Running commands

Every `exec` call runs your command in BusyBox `sh` on a Kitebuild
machine: a Linux userland that runs inside the durable object that holds
the workspace. Commands are real processes on an emulated Linux kernel,
not a JavaScript interpreter.

## What works

- Pipes, redirects, variables, loops, functions, here-documents,
  background jobs with `&` and `wait`, and signals.
- The BusyBox commands: `cat`, `ls`, `find`, `grep`, `sed`, `awk`,
  `sort`, `uniq`, `wc`, `diff`, `patch`, `tar`, `gzip`, `xargs` and the
  rest.
- `git`, working directly on the workspace files: `init`, `status`,
  `add`, `commit`, `log`, `diff`, `branch`, `checkout` and more.
- Hard links, symlinks, `chmod` and `touch -d`, as on Linux.

## What doesn't

- No `npm`, `node`, `python`, compilers or package managers. Running one
  fails with "can't execute '<name>': No such file or directory", and
  installing one isn't possible.
- No `rg` or `jq`. Search with `grep -r`, and handle JSON with `sed` or
  `awk`.
- No network. `git clone` and `git push` fail with an egress policy
  error, and `wget` with "bad address".

## Files

- `cwd` defaults to `/workspace`.
- The machine reads and writes the workspace's own files. There's no
  copy to sync, so a write is visible to the next call and to the HTTP
  file routes right away.
- Only `/workspace` is the workspace's. Anything written elsewhere, such
  as `/tmp` or `/root`, is gone when the durable object restarts.
- `/workspace/.agents/skills` (where this file lives) is a read-only copy
  of files shipped with the Worker. Writes there fail with "Read-only file
  system", and the rest of the command carries on.
