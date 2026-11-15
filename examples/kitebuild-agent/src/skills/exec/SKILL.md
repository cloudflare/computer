---
name: exec
description: How exec works in this workspace. Commands run in a BusyBox Linux userland with a JavaScript toolchain, inside the durable object, not on a full Linux machine. Read this before your first command, and when a command fails in a way a usual Linux machine would not.
---

# Running commands

Every `exec` call runs your command in BusyBox `sh` on a Kitebuild
machine: a Linux userland that runs inside the durable object that holds
the workspace. Pipes, redirects, background jobs and `wait` work as on
Linux.

## Tools

Real programs, built for WebAssembly, which behave as they do on Linux:

- BusyBox: `sed`, `awk`, `grep`, `find`, `tar`, `diff`, `patch` and the rest.
- `rg` and `jq`.

Kitebuild's own implementations, in JavaScript, which cover what builds
and tests use but not every flag yet; their coverage grows over time:

- `git`: `clone`, `pull`, `status`, `diff`, `add`, `commit`, `log`,
  `branch`, `checkout`, `push` and more. Commits use a default identity
  unless you set one.
- `npm` (`install`, `ci`, `run`, `test`, `exec`), `npx`, `pnpm`, `bun`
  (`install` and `run`, not Bun's runtime, bundler or test runner) and
  `node`, which runs a script, `-e` or `-p` in an isolated Worker, with
  no native addons or child processes.
  Scripts see only a few environment variables, such as `HOME`, `PATH`,
  `CI` and `NODE_ENV`, and those that start with `PUBLIC_` or `VITE_`.
  `require` and `import` both load Node's built-in modules and installed
  packages. A built-in that workerd's `nodejs_compat` lacks fails with
  its name.
- `tsc`, the project's own TypeScript. It only typechecks; it never
  writes output files, so build with `vite build` or the project's build
  script instead.
- `vite` and `vitest`, Kitebuild's pinned releases, which run the
  project's config and tests. A warning says so when the project asks
  for another version; that warning is expected and harmless. Vitest
  needs no config file, and its default `node` environment runs tests
  that import the project's code.
- `wrangler`, Kitebuild's own, present whether or not the project
  depends on it. `wrangler deploy --dry-run` bundles the Worker from
  its `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` and lists
  its bindings without uploading anything; add `--outdir dist` to keep
  the bundle. A real deploy fails here, with no API token and no
  network route to Cloudflare, and `wrangler dev` is not implemented.
- `curl`.

To check a Cloudflare Worker, run `wrangler deploy --dry-run` to prove
it bundles, and test its fetch handler from Vitest: call
`app.request("/")` on a Hono app, or
`worker.fetch(new Request("http://localhost/"))`, and assert on the
response. Do not start a dev server; `exec` waits for a command to
exit, so one never returns.

When you create a project, or add these tools to one, pin them to the
releases this machine runs, so the project behaves the same here as
on a usual machine. `vitest --version`, `vite --version` and
`wrangler --version` print them; at the time of writing they are
Vitest 4.1.7, Vite 8.2.2 and Wrangler 4.151.0. For a Worker's tests,
use `cloudflareTest()` from `@cloudflare/vitest-plugin` 1.0.0 in
`vitest.config.ts` and `env` from `cloudflare:workers` in specs. The
older `@cloudflare/vitest-pool-workers/config` and `env` from
`cloudflare:test` work too, but are deprecated upstream.

The files under `/usr/bin` for `rolldown`, `oxc` and the other tools
are empty placeholders; the programs are built into the machine. Do not
run or inspect them.

If one of these exits with code 3 and prints `kitebuild: unsupported:
<feature>: <reason>`, the command used something Kitebuild doesn't
support, and nothing ran. The line says what; change the approach
rather than retrying. `KITEBUILD_UNSUPPORTED=warn` in the command's
environment turns it into a warning.

## When the toolchain itself fails

An error that names one of the toolchain's internal programs, such as
`rolldown exit 127`, `portable CLI: bundling ... failed` or
`vitest: bundling failed for <file>` on a test that only imports
`vitest`, means the machine is broken, not the project. Check with
`node -e "console.log(1)"`: if that fails too, nothing you change in
the project will help. Stop, leave the project as it was, and report
the exact error. Do not create scratch projects, rewrite configs,
switch file extensions or reinstall packages to work around it.

## Limits

- Network access is limited to GitHub and the npm registry. Other hosts
  are refused by the egress policy.
- No `python`, compilers or other native programs. Running one fails with
  "can't execute '<name>': No such file or directory".
- `time` is not available; it needs `vfork`, which this machine does not
  implement.
- `tsc` may report errors inside `node_modules`, because some packages
  are installed types-only. Set `"skipLibCheck": true` to check only the
  project's code.
- Only `/workspace` is durable. Anything written elsewhere is gone when
  the durable object restarts.
- `/skills` (where this file lives) is read-only.
