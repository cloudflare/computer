# Remote exec example

Codemode code calls `codemode:exec` from `@cloudflare/computer/remote-exec`. Its `exec()` runs a
command in a real container and returns a process shaped like `ctx.container.exec()`'s. Workspace
files are pushed in before the command runs, and its changes are pulled back after it exits:

```js
import { exec } from "codemode:exec";

export default async function () {
  const proc = await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] });
  const { exitCode, stdout } = await proc.output();
  return { exitCode, stdout: new TextDecoder().decode(stdout) };
}
```

## Run it

You need Docker. From the repository root:

```bash
npm run build
npm run test:e2e --workspace @example/computer-remote-exec
```

`npm run dev --workspace @example/computer-remote-exec` starts it in `vite dev` instead.

The tests start `vite dev`, which builds the container image, and run the vitest suites in
`test/` against it. Each suite has its own workspace and container, destroyed when it ends, and
sends codemode programs to `POST /s/:session/run`:

- `sync`: push with `.gitignore`, run, then pull, including deletions, with ignored files kept
  out in both directions. A second push sends only what changed. Push and pull globs are
  relative to `cwd`. `user: "1000:1000"` runs the command as that user, who owns the files
  pushed for it.
- `streams`: the process's streams and `stdin: "pipe"`, `exitCode` waiting for both pipes,
  `output()` as bytes and only once, a stream as stdin and `stderr: "combined"`, a failing
  command's exit code and `kill()`, and long output keeping its last 2,000 lines with the rest
  saved to `/.computer/output/*.stdout.log`.
- `processes`: concurrent syncing calls take turns and pull only their own changes. An abort
  SIGKILLs everything the command started and skips the pull. Background processes don't outlive
  their call, and a command still running when the code ends is killed, freeing the root's lock.
  A command that can't start rejects `exec()`.
- `read-only`: through `POST /s/:session/run-read`, on a read-only `CodemodeBackend`. Commands
  run as nobody and can read pushed files but not change them, and `pull` and `user` are refused.

The routes are `PUT` and `GET /s/:session/files/<path>` for workspace files, `POST
/s/:session/run` and `/run-read` for codemode programs, and `DELETE /s/:session` to destroy the
session's container.

## How it fits together

`Sandbox` is the container's Durable Object. It holds an `executor()`, which starts the container
on the first command, and gives it an `exec()` for the Worker to call. `WorkspaceObject` holds the
workspace and a `CodemodeBackend`, whose `codemode:exec` runs commands on the session's `Sandbox`.

The container image is Docker's agent-less
[sandbox image](https://docs.docker.com/ai/sandboxes/agents/shell/), without `remote-exec`: the
Worker carries the build and copies it into the container on first use. The container is
`linux/amd64`, as Cloudflare runs it and `vite dev` builds it, so that's just the x86_64 build.

`remoteExec()` in `vite.config.ts` gets it from the `@cloudflare/computer` GitHub release matching
the installed package, checks it against the release's `SHA256SUMS`, and caches it. The Worker
imports it as `computer:remote-exec`. Built with `vite build`, it streams the build from
`/bundle` with `node:fs`, a chunk at a time, so it never holds the 1.5 MB build in memory. Under
`vite dev`, which doesn't put files under `/bundle`, it imports the build instead.

## Using the remote-exec image instead

To bake remote-exec into the image rather than have the Worker copy it in, copy it from the
`cloudflare/computer-remote-exec` image, whose version matches `@cloudflare/computer`'s, and drop
`binaries` from `createExecModule()` (and `remoteExec()` from `vite.config.ts`):

```dockerfile
FROM ghcr.io/cloudflare/computer-remote-exec:0.11.1 AS remote-exec

FROM docker/sandbox-templates:shell
COPY --from=remote-exec /usr/local/bin/remote-exec /usr/local/bin/remote-exec
CMD ["sleep", "infinity"]
```

The image is on both `ghcr.io/cloudflare/computer-remote-exec` and
`registry.cloudflare.com/library/computer-remote-exec`.

## Working on remote-exec itself

To try a change to `remote-exec`, build it first. `vite.config.ts` then takes the repository's own
build from `artifacts/remote-exec` instead of the release's. Building needs Rust
with both musl targets and `capnp`; `packages/remote-exec/dev/run.sh` provides them on any machine
with Docker:

```bash
packages/remote-exec/dev/run.sh npm run build:bin --workspace @cloudflare/remote-exec
npm run build
npm run test:e2e --workspace @example/computer-remote-exec
```

On an Arm Mac the container is emulated and runs the same x86_64 build.
