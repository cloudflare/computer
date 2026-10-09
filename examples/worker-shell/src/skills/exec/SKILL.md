---
name: exec
description: How exec works in this workspace. Commands run in just-bash, a bash interpreter inside a Dynamic Worker, not on a Linux machine. Read this before running a command, and when a command is "not found" or behaves differently from real bash.
---

# Running commands

Every `exec` call runs your command in **just-bash**, a bash interpreter
written in JavaScript. It runs inside a Dynamic Worker that the durable
object starts for the call. There is no Linux machine, no container,
and no process table.

## What works

- Pipes, redirects, variables, loops, functions, `&&` and `||`, globs
  and here-documents, the same way they work in bash.
- Text tools: `cat`, `ls`, `find`, `grep`, `sed`, `awk`, `head`, `tail`,
  `sort`, `uniq`, `wc`, `cut`, `tr`, `diff`, `xargs` and the rest of the
  usual set.
- `jq` and `curl`. This example turns both on. They are optional command
  groups that the host chooses.
- A built-in `git` for `clone`, `status`, `diff`, `log` and commits. It
  works directly on the workspace files.

## What doesn't

- No `npm`, `node`, `python`, compilers, package managers or other
  binaries. If a command isn't built in, it is "not found", and
  installing it isn't possible.
- No direct network access. `curl` is there, but requests fail unless
  the host sets up an egress policy, and this example doesn't.
- No background jobs that outlive the call. When the command finishes,
  the Worker is gone.

## Files

- `cwd` defaults to `/workspace`.
- Every file operation goes straight to the durable object's storage.
  There's no copy to sync, so a write is visible to the next call and to
  the HTTP file routes right away.
- `/workspace/r2` is a read-only copy of an R2 bucket.
- `/workspace/.agents/skills` (where this file lives) is a read-only
  copy of files shipped with the Worker.
- A write under either read-only folder doesn't just fail that one
  command. It ends the whole call with exit code 1 and a "read-only
  mount" error, and output printed earlier in the call is lost. Write
  somewhere else under `/workspace` instead.

## Tips

- Starting a call is fast, so many small commands are fine.
- For anything that needs a real runtime, such as building, testing or
  installing, use a workspace with a container backend.
