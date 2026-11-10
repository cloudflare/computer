# Remote exec example

Codemode code calls `codemode:exec`, or the streaming `codemode:remote-exec`, from
`@cloudflare/computer/remote-exec`. That runs commands in a real container through
`ctx.container.exec()`, pushing files from a computer workspace before the command and pulling
changes back after it. The container image is Docker's agent-less
[sandbox image](https://docs.docker.com/ai/sandboxes/agents/shell/). The container is
`linux/amd64`, so the Worker carries just the x86_64 `remote-exec` build, and streams it into the
container on first use. `scripts/fetch-remote-exec.sh` puts it at `bin/remote-exec`. It uses the
repository's own build when there is one, and otherwise the one attached to the matching
`@cloudflare/computer` GitHub release, checked against its `SHA256SUMS`. It runs before
`npm run dev` and the end-to-end tests.

`wrangler.jsonc`'s `rules` upload `bin/remote-exec` as a module of its own, which workerd shows at
`/bundle/remote-exec`. `fileRemoteExec()` reads it from there with `node:fs`, a chunk at a time,
both to hash it and to copy it in, so the Worker never holds the 1.5 MB build in memory. Importing
it would, and would also rename it in the bundle.

```js
import { exec } from "codemode:exec";

export default async function () {
  return await exec(["npm", "test"], { cwd: "/workspace/app", push: ["**"], pull: ["coverage/**"] });
}
```

## Run it

You need Docker, and [cctr](https://github.com/andreasjansson/cctr) for the tests. Building
`remote-exec` needs Rust with both musl targets and `capnp`, which
`packages/remote-exec/dev/run.sh` provides on any machine with Docker. From the repository root:

```bash
packages/remote-exec/dev/run.sh npm run build:bin --workspace @cloudflare/remote-exec   # optional
npm run build
npm run test:e2e --workspace @example/computer-remote-exec
```

Without the first step, the example uses the released builds for the installed
`@cloudflare/computer`.

`scripts/e2e.sh` starts `wrangler dev`, which builds the container image. It then runs the cctr
tests in `test/` against it and stops it. Extra arguments go to cctr
(`npm run test:e2e --workspace @example/computer-remote-exec -- -p abort`). Each test sends a
codemode program to `POST /s/:session/run` through `test/bin/workspace` and shows what it
returns. Each suite has its own workspace and container, destroyed when it ends:

- `sync`: push with `.gitignore`, run, then pull, including deletions, with ignored files kept
  out in both directions. A second push sends only what changed. Push and pull globs are
  relative to `cwd`. `user: "1000:1000"` runs the command as that user, who owns the files
  pushed for it.
- `streams`: the `codemode:remote-exec` facade's lazy streams and `stdin: "pipe"`, `output()` as
  bytes, string stdin and `stderr: "combined"`, a failing command's exit code, and long output
  keeping its last 2,000 lines with the rest saved to `/.computer/output/*.stdout.log`.
- `processes`: concurrent syncing calls take turns and pull only their own changes. An abort
  SIGKILLs everything the command started and skips the pull. Background processes don't outlive
  their call. A command that can't start rejects `exec()`.
- `read-only`: through `POST /s/:session/run-read`, on a read-only `CodemodeBackend`. Commands
  run as nobody and can read pushed files but not change them, and `pull` and `user` are refused.

`wrangler dev` builds the image for `linux/amd64`, as Cloudflare runs it. On an Arm Mac the
container is emulated and runs the same x86_64 build of `remote-exec`.

Other routes: `PUT /s/:session/files/<path>` writes a workspace file, and `DELETE /s/:session`
destroys the session's container. `POST /s/:session/exec` calls `remoteExec()` directly from the
Durable Object, with raw streams.

## Using the remote-exec image instead

To bake remote-exec into the image rather than have the Worker copy it in, copy it from the
`cloudflare/computer-remote-exec` image, whose version matches `@cloudflare/computer`'s, and drop
`binaries` from `createExecModule()` (and `bin/remote-exec`'s rule from `wrangler.jsonc`):

```dockerfile
FROM ghcr.io/cloudflare/computer-remote-exec:0.10.0 AS remote-exec

FROM docker/sandbox-templates:shell
COPY --from=remote-exec /usr/local/bin/remote-exec /usr/local/bin/remote-exec
CMD ["sleep", "infinity"]
```

The image is on both `ghcr.io/cloudflare/computer-remote-exec` and
`registry.cloudflare.com/library/computer-remote-exec`.
