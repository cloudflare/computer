# FUSE mount option benchmarks

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
