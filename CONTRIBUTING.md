# Contributing

Thanks for working on the Cloudflare Computer prototype. This document
covers the day-to-day mechanics: how to set up the repo, how to run the
checks, and how to shape commits and pull requests.

Agents working in this repo should also read [`AGENTS.md`](AGENTS.md),
which points at the in-repo skills under [`.agents/skills/`](.agents/skills/).

## Setup

Requirements:

- Node 22 or newer (`packages/computerd` declares `"engines": { "node": ">=22" }`).
- npm — this repo uses npm workspaces, not pnpm or yarn.
- Linux with FUSE if you want to run `packages/computerd` end-to-end. The
  rest of the workspace builds and tests on macOS as well.
- Docker, optionally, for `examples/container`.

Clone and install from the repo root:

```bash
git clone https://github.com/cloudflare/computer.git
cd computer
npm install
```

`npm install` resolves all workspaces in one pass. Don't run `npm install`
inside a single package — it produces a nested lockfile and confuses
the workspace resolver.

## Repository layout

The repo is a small monorepo. Each package owns its own `README.md`
with package-specific status and usage notes:

- [`packages/dofs`](packages/dofs/) — Durable Object SQLite-backed virtual
  filesystem, sync protocol building blocks, and a `@platformatic/vfs`
  provider for Node.
- [`packages/rpc`](packages/rpc/) — capnweb-based wire types and
  server/client helpers shared between the Durable Object and `computerd`.
- [`packages/computerd`](packages/computerd/) — the `computerd` daemon: a FUSE mount plus
  HTTP/WebSocket RPC server that runs inside the sandbox container.
- [`packages/computer`](packages/computer/) — the top-level
  `@cloudflare/computer` package consumed by Durable Objects.

[`docs/`](docs/) holds the design specification. It is forward-looking
and has diverged from `main` in places — treat it as intent, not as a
description of the code today.

## Code changes

Touch the package that owns the behavior. Cross-package changes are
fine, but group them into one logical change per commit.

When you finish a task:

- Update the affected package's `README.md` if its implementation
  status changes.
- Run the checks below.

## Formatting and linting

Biome handles both formatting and linting. From the repo root:

```bash
npm run format        # biome format --write .
npm run check         # biome lint + formatter verification
```

`npm run format` is allowed to rewrite files. `npm run check` must
exit zero before you push. If `check` complains, fix the underlying
issue rather than silencing the rule — disabled rules need a real
justification, not a shrug.

## Tests

Run the package-level tests for whatever you touched. For the whole
workspace:

```bash
npm test
```

For a single package:

```bash
npm test --workspace @cloudflare/dofs
```

For a single test file inside a package:

```bash
npm test --workspace @cloudflare/dofs -- src/path/to/file.test.ts
```

`packages/computerd` includes FUSE-backed tests that only run on Linux. On
other platforms they're skipped automatically.

New behavior needs a test. Bug fixes need a reproduction test that
failed before the fix. See [`.agents/skills/test-driven-development/SKILL.md`](.agents/skills/test-driven-development/SKILL.md)
for the testing approach this repo follows.

## Typecheck and build

```bash
npm run typecheck     # tsc --noEmit across workspaces
npm run build         # library builds
npm run build:all     # libraries, bundled binaries, docker images
```

`build:all` is the union of `build`, `build:bin`, and `build:docker`.
Only run it if you actually need the binary or docker artifacts; it's
slow.

## Commit messages

Commit messages are read out of context, years later, by people with
no memory of the change. Write them for that reader.

The full guidance lives in
[`.agents/skills/prose/SKILL.md`](.agents/skills/prose/SKILL.md). The
short version:

- **Subject line.** Imperative mood, ≤ 50 characters where possible,
  72 hard maximum. No trailing period. Prefix with the package or
  scope: `dofs:`, `rpc:`, `computer:`, `computerd:`, `examples/think:`,
  `docs:`, `ci:`. Multiple scopes are joined with commas, as in
  `computerd, rpc: …`.
- **Blank line**, then a body wrapped at 72 characters. Explain *what
  and why*, not *how* — the diff already shows how.
- **One logical change per commit.** Don't bundle unrelated edits.
- **Self-contained.** No references to chat history, agent sessions,
  review threads, or sibling commit SHAs. A reader on `main` in five
  years should understand the commit from its message alone.
- **No marketing voice, no emojis, no headings or bulleted lists in
  the body.** Prose paragraphs.
- **American English** in prose. Code identifiers keep their original
  spelling.

`git log` is the canonical style reference. Skim a page of it before
your first commit.

## Pull requests

A pull request tells the story behind a set of commits. Full guidance
lives in [`.agents/skills/pull-requests/SKILL.md`](.agents/skills/pull-requests/SKILL.md);
the shape is:

1. The problem the change is solving, with a link to the issue if one
   exists.
2. The solution and how it addresses the problem.
3. How a reviewer can verify it locally — a command, a snippet, or a
   description of the manual test.
4. The testing strategy: what's covered, what isn't.
5. Documentation changes, if any.
6. Known follow-ups.

Keep pull requests scoped to one logical change where you can. Don't
include lists of changed files — the diff is right there.

## What not to commit

- `node_modules/`, `dist/`, `artifacts/`. These are already ignored,
  but double-check `git status` before staging.
- `.env` and `.dev.vars`. Local secrets and per-developer settings
  stay on your machine.
- Editor or OS scratch files. Add them to your global gitignore
  rather than to this repo's `.gitignore`.
- Generated `worker-configuration.d.ts` files, except for the copies
  checked in under `examples/`.
