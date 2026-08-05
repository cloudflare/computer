# Agent guidelines

## Read these first

- [`README.md`](README.md) — what this repo is and how the pieces
  fit together.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — public contribution paths.
- [`COLLABORATORS.md`](COLLABORATORS.md) — setup, checks, commit and
  pull request conventions. The canonical source for the day-to-day
  workflow.
- [`docs/README.md`](docs/README.md) — design specification. Forward-
  looking; treat as intent, not as a description of `main`.
- [`docs/08_capnweb_interface.md`](docs/08_capnweb_interface.md) —
  the RPC contract between the Durable Object and `computerd`. Required
  reading before touching `packages/rpc` or `packages/computer`.
- Each package's own `README.md` — implementation status and
  package-specific notes.

## Skills

In-repo skills live under [`.agents/skills/`](.agents/skills/). Load
the file directly when the trigger applies:

| Skill | Load when |
|---|---|
| [`prose`](.agents/skills/prose/SKILL.md) | Writing code comments, commit messages, READMEs, or documentation. |
| [`pull-requests`](.agents/skills/pull-requests/SKILL.md) | Writing or editing a pull request description. |
| [`test-driven-development`](.agents/skills/test-driven-development/SKILL.md) | Implementing logic, fixing a bug, or changing behavior. |
| [`capnweb`](.agents/skills/capnweb/SKILL.md) | Touching anything that crosses the RPC boundary: `packages/rpc`, `packages/computer`, the `computerd` client, or the Durable Object server. |
| [`cloudflare`](.agents/skills/cloudflare/SKILL.md) | Index of host-side Cloudflare skills — Workers, Durable Objects, wrangler, sandbox SDK, agents SDK. |

## Environment setup

A fresh container does not have everything the tests need. The traps
below cost real time if you discover them one failure at a time.

**Native build tools.** `packages/computerd` depends on `fuse-native`, a
native addon. Building it needs a C toolchain and the libfuse2 headers.
On Debian or Ubuntu:

```bash
apt-get install build-essential libfuse-dev
```

If the `fuse-native` build fails, `npm install` aborts the whole
install, not just that one package. When you only need the rest of the
workspace, install with `npm install --ignore-scripts` to skip the
native build.

**arm64 hosts.** `fuse-native` ships a prebuilt libfuse for x64 only.
On a Linux arm64 host or container (including a Linux container on
Apple Silicon, or arm64 CI) the link fails with `file in wrong
format`. The path below is Debian or Ubuntu arm64; a native macOS host
uses macFUSE instead and does not hit this. Replace the bundled library
with the system one and rebuild:

```bash
cp /usr/lib/aarch64-linux-gnu/libfuse.so.2 \
   node_modules/fuse-shared-library-linux/libfuse/lib/libfuse.so
cd node_modules/fuse-native && npx node-gyp rebuild
```

**Build before you test.** The test scripts don't build the sibling
packages first. Several suites need build output that is absent in
a clean checkout: `packages/computerd` imports the sibling `@cloudflare/dofs`
and `@cloudflare/computer-rpc` packages from their `dist/`
directories, `packages/computerd`'s `src/cli/computerd.test.ts` spawns the bundled
CLI at `dist/cli/computerd.cjs`, and `examples/think-compare-runtimes`
imports `@cloudflare/computer/backends/container`, which exists only
after the `computer` package is built. Run `npm run build` across the
npm workspace before `npm test` on a clean checkout.

**Real FUSE needs privilege.** `packages/computerd`'s `src/cli/computerd.test.ts`
runs its real-FUSE case only when `/dev/fuse` is reachable; otherwise
it resolves to the shim and skips. The guard is a bare existence check,
so a `mknod`'d `/dev/fuse` in an unprivileged container defeats the
skip and the mount then fails with `EPERM`, turning a clean skip into a
hard failure. Leave the device absent unless the container is
privileged (`--privileged`, or `CAP_SYS_ADMIN` with device access). The
`src/exec/runner.fuse.test.ts` suite is separate: it skips unless both
Docker and the prebuilt `computerd` binary are available, and runs `computerd`
inside a privileged container. See the
[`debugging-computerd-fuse`](.agents/skills/debugging-computerd-fuse/SKILL.md) skill
for the privileged Docker setup.

## Checks before you finish

Run from the repo root:

```bash
npm run format        # biome format --write .
npx biome check .     # biome lint + formatter verification
```

`biome check` must exit zero. Fix the underlying issue rather than
silencing the rule.

Then run the package-level tests for whatever you touched:

```bash
npm test                                                  # whole workspace
npm test --workspace @cloudflare/dofs                     # one package
npm test --workspace @cloudflare/dofs -- src/foo.test.ts  # one file
```

Full details, including typecheck and build commands, are in
[`COLLABORATORS.md`](COLLABORATORS.md).

## Commits and pull requests

Follow [`COLLABORATORS.md`](COLLABORATORS.md). The short version:

- One logical change per commit.
- Imperative subject prefixed with the scope (`dofs:`, `rpc:`, `computer:`,
  `computerd:`, `examples/think:`, `docs:`, `ci:`). Multiple scopes
  joined with commas.
- Self-contained body wrapped at 72 characters. No references to chat
  history, agent sessions, sibling commit SHAs, or task identifiers.
- No emojis. No marketing voice. Prose paragraphs in the body, not
  bulleted lists.

Full guidance is in [`.agents/skills/prose/SKILL.md`](.agents/skills/prose/SKILL.md)
and [`.agents/skills/pull-requests/SKILL.md`](.agents/skills/pull-requests/SKILL.md).

## Scripts

Two top-level directories hold helper scripts. They're outside the
npm workspace package set on purpose — they're tooling, not shipped code.

[`script/`](script/) holds maintainance scripts and operator-facing harnesses for `computerd` and the sync
loop. Reach for these when you're chasing a behavior the unit tests don't cover.

- `shell` boots a debian-slim container with the linux `computerd` binary
  mounted under `/usr/local/bin`. The starting point for anything
  that needs a real FUSE mount.
- `computerd-soak.mjs` boots two `computerd` containers wired peer-to-peer and
  soaks the sync loop. Use it to chase convergence or churn bugs.
- `computerd-stub-soak.mjs` soaks the long-lived WebSocket session and
  reads `session.getStats()` to detect stub-disposal drift. Run it
  for changes around the capnweb lifecycle.
- `computerd-fuse-flush.mjs` end-to-end checks that the FUSE driver spills
  its in-memory write buffer into the backing VFS, so a capnweb-side
  `pullOnce` actually sees the bytes.
- `fs-tests.sh` / `run-fs-tests.sh` run the filesystem conformance
  harness against the FUSE mount.
- `fs-bench.sh` / `run-fs-bench.sh` benchmark common development
  tasks against the mount with a tmpfs baseline for comparison.
- `exec-tests` boots `computerd` in docker with FUSE disabled and exercises
  a few `shell.exec` scenarios.
- `npm-bench.sh` / `run-npm-bench.sh` benchmark npm package installs
  on native disk vs the FUSE mount. `run-npm-bench.sh` is the
  user-facing entry point that boots a privileged Docker container;
  `run-npm-bench-inner.sh` is the in-container entrypoint that installs
  dependencies, starts `computerd`, and invokes `npm-bench.sh`, which runs
  the actual benchmark. Set `SCENARIOS`, `REPS`, `WARMUP`, and
  `OUTPUT_JSON` to control what runs and where results land.

When you add a script, drop a one-line description at the top of the
file and add it to the list above.

## Project-specific patterns

- **RPC.** The wire contract is capnweb. Read
  [`docs/08_capnweb_interface.md`](docs/08_capnweb_interface.md) and
  the [`capnweb`](.agents/skills/capnweb/SKILL.md) skill before
  changing anything that crosses the Durable Object ↔ `computerd` boundary.
  Stubs are object-capabilities; dispose them. Leaks are tracked by
  the harness in `packages/rpc`.
- **Storage.** `packages/dofs` is the authoritative SQLite layer.
  Filesystem primitives operate on a `Database` handle; the sync
  protocol building blocks share the same handle. The package README
  enumerates the exported surface.
- **FUSE shim.** `packages/computerd` runs in the sandbox container. FUSE-
  backed tests only run on Linux and are skipped elsewhere
  automatically.
- **Examples are real consumers.** `examples/think`,
  `examples/container`, and `examples/worker-shell` exercise the public
  surface. If you change a public API, update them in the same
  change.
