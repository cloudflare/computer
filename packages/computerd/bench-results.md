# Store and FUSE mount option benchmarks

## In-memory store versus file-backed store

Numbers from `script/store-compare.mjs`, which
drives the dofs filesystem directly against both storage backends.
It deliberately skips FUSE so a difference here is the store and
nothing else. 2,000 files in one directory, Node 24 on a Linux
container.

| Store | create 2000 | stat cold | stat warm | readdir x50 |
|---|---:|---:|---:|---:|
| memory | 180.9 ms | 1580.4 ms | 12.1 ms | 155.4 ms |
| file, 64 MiB cache | 659.1 ms (3.64x) | 1558.7 ms (0.99x) | 15.1 ms (1.25x) | 143.1 ms (0.92x) |
| file, 256 MiB cache | 650.0 ms (3.59x) | 1509.8 ms (0.96x) | 13.8 ms (1.14x) | 146.9 ms (0.95x) |

Two findings, one of which contradicts what we assumed when writing
the plan.

**Metadata reads do not regress.** Cold `stat` of 2,000 paths is a
wash (0.96x to 0.99x), and `readdir` is if anything slightly faster
on the file store. The plan predicted this was where a file-backed
store would hurt. It does not, because the working set here is about
1.4 MiB — small enough to sit entirely in SQLite's page cache, so the
reads never reach the disk. Warm `stat` is 1.14x to 1.25x slower,
which is the resolve cache doing its job in both cases and the
remaining difference being page-cache lookup overhead rather than
input or output.

**Writes are the real cost, and the cause is fsync.** Creating 2,000
files is 3.6x slower on the file store. Varying `synchronous` isolates
it:

| `synchronous` | create 1000 files |
|---|---:|
| `full` | 444.6 ms |
| `normal` | 291.9 ms |
| `off` | 148.1 ms |

`off` matches the in-memory store, so the gap is entirely the cost of
flushing to disk. `normal` is the shipped default and already buys
back a third of `full`. Anything faster trades durability for speed,
which is defensible here because the durable object is the source of
truth, but `off` risks a corrupt database on host loss rather than
merely losing recent transactions, so it stays off the table.

Sweeping the cache budget changes almost nothing. At 6,000 files the
database is 3.8 MiB; squeezing the cache to 2 MiB, so the working set
genuinely cannot fit, still leaves cold `stat` at 0.99x:

| Store | create 6000 | stat cold | stat warm | readdir x50 |
|---|---:|---:|---:|---:|
| memory | 391.9 ms | 14389.1 ms | 34.4 ms | 437.1 ms |
| file, 2 MiB cache | 1682.0 ms (4.29x) | 14177.7 ms (0.99x) | 55.4 ms (1.61x) | 474.4 ms (1.09x) |

That is the interesting result. The prediction was that a cache too
small for the tree would turn every resolve into a `pread` and wreck
the metadata numbers. It does not, because cold `stat` is dominated by
the resolve walk itself rather than by fetching pages, and the
operating system's own page cache absorbs what SQLite evicts. Warm
`stat` is where the difference shows, and it is 20 microseconds per
operation on a path that is already cheap.

## Through a real FUSE mount

The numbers above isolate the storage layer. These run the same
comparison through `script/fs-bench.sh` against a real kernel FUSE
mount, with `computerd` started on the host (`FUSE_MOUNT=fuse`), and
`/tmp` as the baseline. REPS=2, WARMUP=1.

| Scenario | memory store | file store | baseline |
|---|---:|---:|---:|
| stat 1000 files | 2777.3 ms (1.10x) | 3114.9 ms (1.22x) | ~2540 ms |
| create 1000 files | 989.4 ms (0.98x) | 1178.7 ms (1.17x) | ~1010 ms |
| write 64 MiB | 238.1 ms (11.14x) | 221.9 ms (12.69x) | ~19 ms |
| overwrite 64 MiB | 294.3 ms (26.16x) | 304.6 ms (29.30x) | ~11 ms |

Large-file input and output is unchanged between the two stores, which
is what the storage-layer numbers predicted: those paths are dominated
by chunking and the FUSE round trip, so the store barely registers.
The small-file scenarios cost 10 to 20 percent more on disk. That is a
real regression, and smaller than the 3.6x the storage-layer create
number would suggest on its own, because FUSE overhead dilutes it.

## Restore time

What the on-disk store buys, measured by `script/restore-time.mjs`. It
times the interval a host actually waits: from a healthy daemon to a
workspace the peer agrees is current, meaning connect, reconcile
watermarks, and push whatever the peer believes is missing.

| Tree | store | first boot | restart |
|---|---|---:|---:|
| 500 files | memory | 454 ms (502 pushed) | 480 ms (502 pushed) |
| 500 files | file | 451 ms (502 pushed) | **26 ms (0 pushed)** |
| 3,000 files | memory | 3725 ms (3002 pushed) | 3749 ms (3002 pushed) |
| 3,000 files | file | 4063 ms (3002 pushed) | **23 ms (0 pushed)** |

An in-memory store re-ships the whole tree on every restart, so its
restart cost tracks the tree size. A file store ships nothing, because
the sync cursors came back with the files and the peer can see there
is no difference to send. The saving is 18x at 500 files and 161x at
3,000, and it keeps growing: the restore side stays flat at roughly
25 ms while the memory side climbs with the workspace.

This is the trade in one line. Small-file work costs 10 to 20 percent
more, and a restart costs a fixed 25 ms instead of a full replay.

Caveats. These run on one Linux container, not on Cloudflare
Containers hardware. The restore measurement drives the sync protocol
directly rather than through a real durable object over a real
network, so it captures the work avoided but not the round-trip
latency a real host would also save. The full `cloudflare/sandbox-sdk`
`npm install` comparison has not been run.

## FUSE mount option benchmarks

Numbers from running `script/run-fs-bench.sh` against the linux-x64
`computerd` binary in a privileged docker container, with the bench's pure
large-file scenarios. Measurements were taken on Apple Silicon under
qemu/x86 emulation, which inflates the absolute numbers but the
relative comparisons hold. Re-run the harness on a native Linux host
before drawing tuning conclusions for production.

The harness creates a fresh subdirectory per repetition, so every
scenario reads its target file exactly once per timed sample. That
shape exercises the FUSE per-op path and the dirty-buffer spill, but
does not exercise cross-open kernel page-cache reuse.

## Setup

```bash
# Build the linux-x64 computerd binary.
npm run build:bin --workspace @cloudflare/computerd

# Boot computerd in a docker container, run the bench inside it, drop the
# JSON output on the host.
docker run --rm --platform linux/amd64 --privileged \
  --device /dev/fuse --cap-add SYS_ADMIN --cap-add MKNOD \
  -v $PWD/artifacts/computerd/computerd-linux-x64:/usr/local/bin/computerd:ro \
  -v $PWD/script/fs-bench.sh:/usr/local/bin/fs-bench:ro \
  -v $PWD/script/run-fs-bench.sh:/run-bench.sh:ro \
  -v $PWD/bench-out:/out \
  -e REPS=3 -e WARMUP=1 \
  -e OUTPUT_JSON=/out/results.json \
  -e SCENARIOS='pure read,pure copy,overwrite,write 64' \
  debian:stable-slim bash /run-bench.sh
```

The production-safe profile (auto_cache plus one-second metadata
timeouts) is the built-in default; the numbers below were captured
with no COMPUTERD_FUSE_* env vars set. To opt out of auto_cache for a
run, set COMPUTERD_FUSE_AUTO_CACHE=0.

## Results

Mean over three reps with one warmup. All times in milliseconds.

The default column reflects the production-safe profile that the
daemon ships with today (auto_cache plus one-second attr_timeout,
entry_timeout, and ac_attr_timeout). The kernel_cache column ran
with COMPUTERD_FUSE_AUTO_CACHE=0 and COMPUTERD_FUSE_KERNEL_CACHE=1.

| Scenario          | native baseline | default (auto_cache) | kernel_cache |
|-------------------|----------------:|---------------------:|-------------:|
| write 64 MiB      |            32.3 |                213.7 |            — |
| pure read 64 MiB  |            26.0 |                 45.3 |         28.4 |
| pure copy 64 MiB  |            32.3 |                252.3 |        245.4 |
| overwrite 64 MiB  |            28.9 |                185.9 |        185.4 |

## What the numbers say

`kernel_cache` brings pure-read latency from 44 ms down to 28 ms, very
close to the native 26 ms baseline. The win lines up with the
expectation: with the cache option enabled the kernel reuses page-
cache contents across reads of the same offsets within one open
instead of issuing a fresh FUSE round-trip per `read` call.

`auto_cache` ships as the default. The benchmark reads each target
file exactly once per rep in a fresh directory, so there is nothing
in the page cache for `auto_cache` to invalidate or reuse on open;
the numbers above measure the absence of regression rather than the
speed-up `auto_cache` delivers in production. A read-heavy workload
that reopens the same file repeatedly is the right shape to see the
cache reuse pay off.

Copy, overwrite, and write are all dominated by the write side of the
operation. The driver buffers writes in memory and spills the whole
file through `vfs.writeFileSync` on `flush`, which goes through
SQLite-backed chunking in `@cloudflare/dofs`. None of the cache
options touch that path, so they don't move the numbers. Chunk-aware
or streaming spill is the next lever for these scenarios, as called
out in the handoff under "larger future optimization".

## Notes on safety

`kernel_cache` is unsafe as a default. It tells the kernel that the
page cache is never invalidated, so a sync push that lands new bytes
in the VFS does not propagate to a container that already has the
file open. Reserve it for fast / single-writer profiles where the
container is the only writer.

`auto_cache` is the production-safe default. It invalidates the
page cache on open when mtime or size changed. The contract rests on
three tests. Two in `packages/computerd/src/fuse/driver.test.ts` pin that
the FUSE driver's `getattr` surfaces fresh mtime and size after an
external VFS write and after a buffered local write. Four more in
`packages/dofs/src/sync/apply.test.ts` pin that the sync apply path
propagates the source mtime onto the destination row, including the
tricky same-size-bytes-change case. If a future refactor breaks any
of those tests, treat that as a signal that `auto_cache` is no
longer safe and revert the default before merging.
