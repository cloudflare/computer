# Collaborator guide

This document is for approved collaborators with pull request access. Public contribution paths are documented in [`CONTRIBUTING.md`](CONTRIBUTING.md).

It covers the day-to-day mechanics: how to set up the repo, how to run checks, and how to shape commits and pull requests.

## Setup

Requirements:

- Node 22 or newer. `packages/computerd` declares `"engines": { "node": ">=22" }`.
- npm. This repo uses npm workspaces, not pnpm or yarn.
- Linux with FUSE if you want to run `packages/computerd` end-to-end. The rest of the workspace builds and tests on macOS as well.
- Docker, optionally, for `examples/container`.

Clone and install from the repo root:

```bash
git clone https://github.com/cloudflare/computer.git
cd computer
npm install
```

`npm install` resolves all workspaces in one pass. Do not run `npm install` inside a single package. It creates a nested lockfile and confuses the workspace resolver.

## Repository layout

The repo is a small monorepo. Each package owns its own `README.md` with package-specific status and usage notes:

- [`packages/dofs`](packages/dofs/) — Durable Object SQLite-backed virtual filesystem, sync protocol building blocks, and a `@platformatic/vfs` provider for Node.
- [`packages/rpc`](packages/rpc/) — capnweb-based wire types and server/client helpers shared between the Durable Object and `computerd`.
- [`packages/computerd`](packages/computerd/) — the `computerd` daemon: a FUSE mount plus HTTP/WebSocket RPC server that runs inside the sandbox container.
- [`packages/computer`](packages/computer/) — the top-level `@cloudflare/computer` package consumed by Durable Objects.
- [`packages/computer-computerd-linux-x64`](packages/computer-computerd-linux-x64/) — the prebuilt `computerd` binary for linux-x64, distributed for use in container images.

[`docs/`](docs/) holds the design specification. It is forward-looking and has diverged from `main` in places. Treat it as intent, not as a description of the code today.

## Code changes

Touch the package that owns the behavior. Cross-package changes are fine, but group them into one logical change per commit.

When you finish a task:

- Update the affected package's `README.md` if its implementation status changes.
- Run the checks below.

## Formatting and linting

Biome handles both formatting and linting. From the repo root:

```bash
npm run format        # biome format --write .
npm run check         # biome lint + formatter verification
```

`npm run format` is allowed to rewrite files. `npm run check` must exit zero before you push. If `check` complains, fix the underlying issue rather than silencing the rule. Disabled rules need a real justification.

## Tests

Run the package-level tests for whatever you touched. For the whole workspace:

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

`packages/computerd` includes FUSE-backed tests that only run on Linux. On other platforms they are skipped automatically.

New behavior needs a test. Bug fixes need a reproduction test that failed before the fix. See [`.agents/skills/test-driven-development/SKILL.md`](.agents/skills/test-driven-development/SKILL.md) for the testing approach this repo follows.

## Typecheck and build

```bash
npm run typecheck     # tsc --noEmit across workspaces
npm run build         # library builds
npm run build:all     # libraries, bundled binaries, docker images
```

`build:all` is the union of `build`, `build:bin`, and `build:docker`. Only run it if you need the binary or Docker artifacts. It is slow.

## Commit messages

Commit messages are read out of context, years later, by people with no memory of the change. Write them for that reader.

The full guidance lives in [`.agents/skills/prose/SKILL.md`](.agents/skills/prose/SKILL.md). The short version:

- **Subject line.** Imperative mood, 50 characters or fewer where possible, 72 hard maximum. No trailing period. Prefix with the package or scope: `dofs:`, `rpc:`, `computer:`, `computerd:`, `examples/think:`, `docs:`, `ci:`. Multiple scopes are joined with commas, as in `computerd, rpc: …`.
- **Blank line**, then a body wrapped at 72 characters. Explain what and why, not how. The diff already shows how.
- **One logical change per commit.** Do not bundle unrelated edits.
- **Self-contained.** No references to chat history, agent sessions, review threads, or sibling commit SHAs. A reader on `main` in five years should understand the commit from its message alone.
- **No marketing voice, no emojis, no headings or bulleted lists in the body.** Prose paragraphs.
- **American English** in prose. Code identifiers keep their original spelling.

`git log` is the canonical style reference. Skim a page of it before your first commit.

## Pull requests

A pull request tells the story behind a set of commits. Full guidance lives in [`.agents/skills/pull-requests/SKILL.md`](.agents/skills/pull-requests/SKILL.md). The shape is:

1. The problem the change is solving, with a link to the issue if one exists.
2. The solution and how it addresses the problem.
3. How a reviewer can verify it locally: a command, a snippet, or a description of the manual test.
4. The testing strategy: what is covered and what is not.
5. Documentation changes, if any.
6. Known follow-ups.

Keep pull requests scoped to one logical change where you can. Do not include lists of changed files. The diff is right there.

External pull requests are closed automatically unless they come from an owner, member, collaborator, Dependabot, Renovate, or carry the `allow-pr` label. Add `allow-pr` before reopening an external pull request that should go through review.

## Releases

Releases run on [changesets](https://github.com/changesets/changesets).
The short version: a change that should ship a new version of
`@cloudflare/computer` needs a changeset alongside it. Everything after
that is automated.

When your change alters what a released package or image does, add a
changeset:

```bash
npm run changeset
```

The prompt asks which bump the change warrants — patch, minor, or
major — and for a one-line summary. It writes a small markdown file
under `.changeset/`. Commit that file with your change. The summary
becomes a line in the changelog, so write it for someone reading the
release notes months from now, not for your reviewer today. A change
that touches only tests, CI, docs, or an example needs no changeset.

Once your pull request merges to `main`, the release workflow takes
over in two steps:

1. It gathers the pending changesets into a "Version Packages" pull
   request that bumps package versions, rewrites changelogs, and updates
   Dockerfile and documentation pins for the `computerd` image. Private
   packages such as `@cloudflare/dofs`, `@cloudflare/computer-rpc`, and
   `@cloudflare/computerd` are versioned and get changelogs, but are not
   published to npm.
2. Merging that pull request first builds and pushes the `computerd`
   binary image to `ghcr.io` and `registry.cloudflare.com`, then publishes
   public npm packages. Rerunning a failed publish is safe: existing image
   tags are pushed again and existing npm versions are skipped.

The package publishes under the `unreleased` dist-tag while it's
pre-1.0, so `npm install @cloudflare/computer` does not yet pick up
these releases. Promoting it to `latest` is a deliberate maintainer
step: drop `publishConfig.tag` from `packages/computer/package.json`.

For a prerelease channel (`alpha`, `beta`, `rc`), a maintainer runs
`npx changeset pre enter <tag>` on `main` before the normal flow, and
`npx changeset pre exit` to leave it. See the
[changesets prerelease docs](https://github.com/changesets/changesets/blob/main/docs/prereleases.md).

## What not to commit

- `node_modules/`, `dist/`, `artifacts/`. These are already ignored, but double-check `git status` before staging.
- `.env` and `.dev.vars`. Local secrets and per-developer settings stay on your machine.
- Editor or operating system scratch files. Add them to your global gitignore rather than to this repo's `.gitignore`.
- Generated `worker-configuration.d.ts` files, except for the copies checked in under `examples/`.
