# 19. Performance

Numbers from `script/fs-bench.sh` and a full
`npm install` of [`cloudflare/sandbox-sdk`](https://github.com/cloudflare/sandbox-sdk)
(854 packages, 36,675 files), running
[`examples/container`](../examples/container) on a Cloudflare
Containers **standard-2** instance (1 vCPU, 6 GiB memory, 12 GB disk).
The computerd FUSE mount lives at `/workspace`; the comparison columns are
an in-memory `tmpfs` at `/tmp` and the container's ext4 root disk at
`/var/tmp`.

Ratios are `computerd / baseline` — lower is faster, values below 1.0 mean
computerd beats the baseline.

## `fs-bench` (REPS=3, WARMUP=1, randomized targets)

| Scenario | computerd | tmpfs | tmpfs ratio | ext4 disk | disk ratio |
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

## Full `cloudflare/sandbox-sdk` `npm install`

| Target | Duration |
|---|---:|
| tmpfs (`/tmp`) | 34.3 s |
| computerd FUSE (`/workspace`) | 124.7 s |
| ext4 disk (`/var/tmp`) | 63.9 s |

computerd is ~2x slower than the container's ext4 disk for the full
`npm install`, and ~3.6x slower than tmpfs. The disk comparison is
the more realistic baseline for general usage.

## In-memory store versus on-disk store

`computerd` keeps its SQLite store in memory by default. Set
`COMPUTERD_DB` to a path and it goes on the container's disk instead.

These numbers come from `script/store-compare.mjs`, which uses the
dofs filesystem directly with 2,000 files in one directory. There is
no FUSE mount involved, so any difference is down to the store.

| Operation | memory | on disk (64 MiB cache) | ratio |
|---|---:|---:|---:|
| create 2000 files | 180.9 ms | 659.1 ms | 3.64x |
| stat 2000 paths, cold | 1580.4 ms | 1558.7 ms | **0.99x** |
| stat 2000 paths, warm | 12.1 ms | 15.1 ms | 1.25x |
| readdir x50 | 155.4 ms | 143.1 ms | **0.92x** |

Reads are not slower on disk. That holds even when the cache is far
too small for the tree: a 2 MiB cache against a 3.8 MiB database still
reads at 0.99x. Two reasons. Most of the time goes on walking the path
rather than fetching pages, and the operating system caches whatever
SQLite drops.

Writes are slower, and the reason is the cost of flushing to disk.
Creating 1,000 files takes 445 ms at `synchronous = full`, 292 ms at
`normal` (what we ship), and 148 ms at `off` — which matches the
in-memory store's 181 ms.

Through a real FUSE mount the write cost shrinks, because the mount
itself is already the bigger expense:

| Scenario | memory store | file store | baseline |
|---|---:|---:|---:|
| stat 1000 files | 2777.3 ms (1.10x) | 3114.9 ms (1.22x) | ~2540 ms |
| create 1000 files | 989.4 ms (0.98x) | 1178.7 ms (1.17x) | ~1010 ms |
| write 64 MiB | 238.1 ms (11.14x) | 221.9 ms (12.69x) | ~19 ms |
| overwrite 64 MiB | 294.3 ms (26.16x) | 304.6 ms (29.30x) | ~11 ms |

## Restore time

This is what the on-disk store buys. `script/restore-time.mjs` times
what a host waits after a restart: connect, compare sync positions,
and send whatever the other side is missing.

| Tree | memory store | file store |
|---|---:|---:|
| 500 files | 480 ms (502 entries sent) | 26 ms (0 sent) |
| 3,000 files | 3749 ms (3002 entries sent) | 23 ms (0 sent) |

An in-memory store sends the whole workspace again after every
restart, so its cost grows with the tree. A file store sends nothing,
because the sync positions came back along with the files. Restoring
takes about 25 ms whatever the size, so the saving grows too: 18x at
500 files, 161x at 3,000.

The trade: small-file work costs 10 to 20 percent more, and a restart
costs a flat 25 ms instead of resending everything.

Two things these numbers do not cover. They come from one Linux
container, not from Cloudflare Containers hardware, and a full
`cloudflare/sandbox-sdk` `npm install` has not been run. The restore
figures also drive the sync protocol in process, so they show the work
avoided but not the network round trips a real host would also skip.

## Where computerd is faster than the disk baseline

The in-memory inode store beats real disk on metadata-heavy work:
`stat`, `rm`, `mkdir tree`, `find tree`, `git init`, `git clone`,
`npm init`. Those eight scenarios cover most of the day-to-day cost
of tools like `git status`, module resolution, and incremental
builds.

## Where computerd is slower

Large sequential file I/O. The computerd write path hashes each
[`CHUNK_SIZE`](../packages/dofs/src/fs/writeFile.ts) (512 KiB) chunk
into a content-addressed blob store on every release; that's how
the Durable Object can sync only the chunks that changed and
deduplicate identical content. The cost lands on raw
`dd`-style throughput numbers but rarely on real developer
workloads, which is why `npm init + tiny install` matches the disk
baseline despite `pure read 64 MiB` being 30x slower.

## Reproducing

```bash
bash script/run-fs-bench.sh
```

or against a deployed `computerd-container` instance, upload
[`script/fs-bench.sh`](../script/fs-bench.sh) and run it with
`MOUNT=/workspace BASE=/tmp`.
