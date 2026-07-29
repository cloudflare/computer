# Cloudflare Workspace

Cloudflare Workspace is a virtual filesystem that lives inside a
Durable Object. The Durable Object holds the authoritative state in
SQLite and exposes the filesystem to a shell through a pluggable
backend. Two backends ship today:

- **Container** projects the SQLite state into a sandbox container as
  a real FUSE mount. A sandbox-side daemon (`wsd`) mounts the state
  as a filesystem and syncs changes back over a capnweb RPC channel.
  Full Linux userland, real binaries, real network.
- **Worker** runs the shell as [just-bash](https://github.com/vercel-labs/just-bash)
  inside a Dynamic Worker loaded through `env.LOADER`. The shell
  reaches the host workspace over Workers RPC, so there is no second
  store and no sync round trip. Broad textual tooling (`cat`,
  `grep`, `awk`, `sed`, `jq`, ...), no container lifecycle.

A single Workspace can host more than one backend at the same
time. Each backend registers under a stable `id`; `shell.exec`
defaults to the first one in the list and the caller routes a
specific call elsewhere with `{ backend: "sandbox" }`. Common
shape: a Worker backend for cheap textual tooling that runs every
command cold, plus a Container backend the agent reaches for when
it needs a real Linux environment for `npm`, `git`, or anything
else the worker isolate can't host. Each backend keeps its own
sync cursors and connects lazily on first use.

Workspace can also be constructed without a backend at all, giving
callers the filesystem on its own.

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](docs/) is forward-looking — read it for
> intent, not as description of the code today.

## Requirements

- Node 22 or newer.
- npm. This repo uses npm workspaces.
- Linux with FUSE if you want to run `packages/wsd` end-to-end. Other
  packages build and test on macOS as well.
- Docker, optionally, for [`examples/container`](examples/container).
  The worker example needs no Docker.

## Quick start

```bash
git clone https://github.com/cloudflare/workspace.git
cd workspace
npm install
npm run build:all
npm test
```

To see the pieces working together, start with the examples:

- [`examples/container`](examples/container) — runs `wsd` inside a
  container, mounts a workspace, and talks to a Durable Object over
  capnweb.
- [`examples/worker`](examples/worker) — same HTTP surface as the
  container example, but the shell runs in a Dynamic Worker loaded
  through `env.LOADER`. No container.
- [`examples/think`](examples/think) — an agent that uses the
  workspace as its working directory.
- [`examples/tutorial`](examples/tutorial) — the smallest version of
  that idea, built up step by step: one endpoint, one file, an agent
  that writes markdown on the host and runs `pandoc` on it in the
  container.

## Repository layout

The repo is a small monorepo. Each package has its own README with
package-specific status and usage notes.

- [`packages/dofs`](packages/dofs/README.md) (`@cloudflare/dofs`) —
  Durable Object SQLite-backed virtual filesystem, sync protocol
  building blocks, and a `@platformatic/vfs` provider for Node.
- [`packages/rpc`](packages/rpc/README.md)
  (`@cloudflare/workspace-rpc`) — capnweb wire types and
  server/client helpers shared between the Durable Object and `wsd`.
- [`packages/wsd`](packages/wsd/README.md)
  (`@cloudflare/workspace-wsd`) — the `wsd` daemon: a FUSE mount plus
  HTTP/WebSocket RPC server that runs inside the sandbox container.
- [`packages/workspace`](packages/workspace/README.md)
  (`@cloudflare/workspace`) — the top-level Workspace package
  consumed by Durable Objects. Work in progress.

## Performance

Numbers from `script/fs-bench.sh` and a full
`npm install` of [`cloudflare/sandbox-sdk`](https://github.com/cloudflare/sandbox-sdk)
(854 packages, 36,675 files), running
[`examples/wsd-container`](examples/wsd-container) on a Cloudflare
Containers **standard-2** instance (1 vCPU, 6 GiB memory, 12 GB disk).
The wsd FUSE mount lives at `/workspace`; the comparison columns are
an in-memory `tmpfs` at `/tmp` and the container's ext4 root disk at
`/var/tmp`.

Ratios are `wsd / baseline` — lower is faster, values below 1.0 mean
wsd beats the baseline.

### `fs-bench` (REPS=3, WARMUP=1, randomized targets)

| Scenario | wsd | tmpfs | tmpfs ratio | ext4 disk | disk ratio |
|---|---:|---:|---:|---:|---:|
| **tiny-file churn** | | | | | |
| create 1000 files | 560.6 ms | 83.2 ms | 6.7x | 303.2 ms | 1.85x |
| stat 1000 files | 1971.9 ms | 1324.2 ms | 1.49x | 2659.3 ms | **0.91x** |
| rm 1000 files | 827.7 ms | 322.7 ms | 2.56x | 1281.8 ms | **0.66x** |
| **directory traversal** | | | | | |
| mkdir tree (10×10×10) | 1597.5 ms | 1585.7 ms | 1.01x | 3034.7 ms | **0.74x** |
| find tree | 1813.6 ms | 1819.9 ms | 1.00x | 4404.2 ms | **0.72x** |
| **large file I/O** | | | | | |
| write 64 MiB | 230.6 ms | 47.3 ms | 4.87x | 16.8 ms | 16.93x |
| copy 64 MiB | 1037.2 ms | 37.4 ms | 27.75x | 39.8 ms | 40.46x |
| read 64 MiB | 437.5 ms | 22.6 ms | 19.33x | 25.6 ms | 39.72x |
| pure read 64 MiB | 263.1 ms | 8.3 ms | 31.54x | 8.5 ms | 30.26x |
| pure copy 64 MiB | 852.9 ms | 21.7 ms | 39.27x | 22.0 ms | 41.47x |
| overwrite 64 MiB | 272.6 ms | 8.3 ms | 32.91x | 8.5 ms | 43.35x |
| **git** | | | | | |
| git init + commit 100 files | 459.2 ms | 40.3 ms | 9.56x | 635.4 ms | **0.72x** |
| git clone (shallow, ~1MB) | 549.1 ms | 421.0 ms | 1.30x | 576.2 ms | **0.84x** |
| **npm** | | | | | |
| npm init + tiny install | 598.5 ms | 630.7 ms | **0.95x** | 630.7 ms | **0.95x** |

### Full `cloudflare/sandbox-sdk` `npm install`

| Target | Duration |
|---|---:|
| tmpfs (`/tmp`) | 34.3 s |
| wsd FUSE (`/workspace`) | 124.7 s |
| ext4 disk (`/var/tmp`) | 63.9 s |

wsd is ~2x slower than the container's ext4 disk for the full
`npm install`, and ~3.6x slower than tmpfs. The disk comparison is
the more realistic baseline for general usage.

### Where wsd is faster than the disk baseline

The in-memory inode store beats real disk on metadata-heavy work:
`stat`, `rm`, `mkdir tree`, `find tree`, `git init`, `git clone`,
`npm init`. Those eight scenarios cover most of the day-to-day cost
of tools like `git status`, module resolution, and incremental
builds.

### Where wsd is slower

Large sequential file I/O. The wsd write path hashes each
[`CHUNK_SIZE`](packages/dofs/src/fs/writeFile.ts) (512 KiB) chunk
into a content-addressed blob store on every release; that's how
the Durable Object can sync only the chunks that changed and
deduplicate identical content. The cost lands on raw
`dd`-style throughput numbers but rarely on real developer
workloads, which is why `npm init + tiny install` matches the disk
baseline despite `pure read 64 MiB` being 30x slower.

### Reproducing

```bash
bash script/run-fs-bench.sh
```

or against a deployed `wsd-container` instance, upload
[`script/fs-bench.sh`](script/fs-bench.sh) and run it with
`MOUNT=/workspace BASE=/tmp`.

## Documentation

- [`docs/`](docs/README.md) — design specification. Forward-looking;
  treat as intent.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, formatting,
testing, commit message, and pull request conventions.

If you're working in this repo as an agent, start with
[`AGENTS.md`](AGENTS.md) and the skills under
[`.agents/skills/`](.agents/skills/).
