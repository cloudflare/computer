---
name: exec
description: How exec works in this workspace. Commands run in bash in a real Linux container, with Node.js, git and network access, and the workspace is synced in and out around each call. Read this before running commands, installing packages, or debugging files that don't show up where you expect.
---

# Running commands

Every `exec` call runs your command with bash in a **Linux container**.
The durable object starts the container, and a small daemon in it,
`computerd`, runs the command.

## What's installed

- Debian, with `bash`, `git`, `curl` and the usual core tools.
- Node.js 22 and `npm`.
- Anything else can be installed with `apt-get` or `npm`. It lasts until
  the container stops.

## Network

The container has direct network access, so `npm install`, `git clone`
and `curl` work.

## Files

- `/workspace` in the container is the workspace. `cwd` defaults to it.
- The durable object's storage holds the authoritative copy. Before each
  call, changes made outside the container are pushed into
  `/workspace`. After the call, changes made in the container are pulled
  back. Something written outside `/workspace` stays in the container
  and isn't saved.
- `/workspace/.agents/skills` (where this file lives) is a read-only
  copy of files shipped with the Worker. Changes you make there in the
  container are dropped when the call ends.

## Things to know

- The first call is slow, because the container has to boot. Later calls
  reuse it while it stays up.
- A container that stops loses everything outside `/workspace`,
  including installed packages. Reinstall rather than assume they're
  still there.
- Every file under `/workspace` is synced back to storage after each
  call. This example keeps no paths on the container's local disk, so a
  large `node_modules` or build folder under `/workspace` slows every
  call down. Put throwaway output in `/tmp`.
