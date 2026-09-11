created: 2026-08-24
last updated: 2026-08-24

# Decisions: restartable synchronization

The unified sync plan left four questions open and deferred one
semantic choice to "existing pull semantics". Implementation cannot
start without answers, so each is decided here with the reasoning that
produced it. Revisit a decision by changing this file in the same
commit that changes the behavior.

## Q1: Should an advanced API allow a replica identity distinct from the backend ID?

**Decision: no. The backend ID is the replica identity.**

The operation table is keyed `(backend, direction)` and the existing
watermark rows are keyed `(k, backend)`. Adding a separate replica
column would give two identifiers that must agree for a cursor to
resolve, and every read path would need to decide what to do when they
disagree. A caller that genuinely needs an independent cursor already
has a mechanism: pass a different backend ID. That reuses the
watermark keying which is already per-backend and already migrated.

The cost is that two consumers who pass the same backend ID share one
cursor. Q4 covers how that is surfaced.

## Q2: What fixed pack block size stays below 30 seconds?

**Decision: start at the plan's conservative constants, make them a
persisted per-operation profile, and only shrink automatically.**

`PACK_BLOCK_MAX_ENTRIES = 4000` and
`PACK_BLOCK_MAX_OBJECT_BYTES = 64 MiB` are the starting profile. The
benchmark moved 256 MB of gzip in 172 s, so 64 MB of objects is
roughly 40 s of transport but only a fraction of that in CPU, and CPU
is what the 30-second limit measures. Rather than guess a single
number that holds across every workload, the profile is stored on the
operation row so an in-flight operation keeps the sizing it started
with.

The plan proposed halving on a detected interruption. Halving without
a matching growth rule is a ratchet: one eviction storm leaves a
workspace permanently slow. So the rule is asymmetric but bounded ---
halve on interruption down to `MIN` (500 entries / 8 MiB), and restore
the default profile when an operation completes. Operations are
short-lived, so "reset on completion" recovers full speed on the next
sync without needing per-block growth heuristics.

## Q3: Can one planning pass feed both threshold selection and the first block?

**Decision: yes, with a bounded probe rather than a full scan.**

Scanning the whole cursor window twice is what makes the current
unbounded path slow to start. The planner instead scans until it has
either drained the window or collected
`max(PACK_BLOCK_MAX_ENTRIES, PACK_THRESHOLD_ENTRIES)` entries. That
probe answers the mode question --- if the probe fills up, the
operation is by definition at or past the entry threshold --- and its
buffer is the first block's metadata. Only metadata is buffered, never
object payloads, so the memory bound is entry records rather than
bytes.

The mode is fixed for the life of the operation. A wrong estimate
therefore cannot be corrected mid-operation, which is the price of a
deterministic, replayable block stream: a block's encoding must not
depend on when it was requested. An operation that guesses "entries"
and turns out large stays in entry mode until it completes, and the
next operation re-decides. Since the target is fixed at creation, the
window cannot grow underneath the estimate, so the error is bounded by
estimation accuracy, not by workload churn.

## Q4: Should remote client wrappers auto-reconnect and recreate iterators?

**Decision: no. Application code owns retry.**

The plan already refuses alarm ownership, and automatic reconnection is
the same class of decision --- it schedules work the application did
not ask for. A wrapper that silently recreates an iterator also hides
the one signal that matters for a lost container: `EEXEC_LOST` is
terminal and must not be retried. Leaving retry to the caller keeps
terminal and recoverable errors distinguishable at the boundary where
the difference is actionable.

Consequence for Q1: because two callers sharing a backend ID join one
operation, `pull()` and `push()` do not silently interleave. Joining
callers observe the same `SyncProgress` values from the shared
generation, and progress values carry `operationId` and `generation`
so a caller can detect that it joined rather than started an
operation.

## Deferred semantic: read-only mount conflicts

The plan reported rejected entries in `SyncProgress` and advanced the
cursor past them, but left "whether completion may advance" to
existing semantics.

**Decision: advance the cursor, and record each rejection durably.**

Not advancing means an unmountable entry stalls the operation forever,
which is worse than dropping it. But a rejection that exists only in
one yielded progress value is unauditable --- whoever consumed that
value may have discarded it. Rejections are therefore written to
`_vfs_sync_skips`, keyed by operation generation, so the drop is
inspectable after the fact. The rows outlive the operation row and are
pruned when a new operation for the same backend and direction starts.

## Deferred semantic: idempotency of replayed applies

The plan asserted replay is idempotent without enumerating which
operations are. Delete replay is the dangerous case: re-applying a
tombstone for a path that a newer local write has recreated would
destroy data.

**Decision: apply is idempotent per entry kind, and delete replay is
guarded by revision.**

A replayed block may only apply an entry whose source revision is at
or above the local revision for that path. `file`, `dir`, and
`symlink` entries are last-writer-wins on identical content, so replay
is a no-op. `delete` compares the tombstone revision against the live
inode revision and skips when the local path is newer. This is
verified by test rather than asserted.

## Decisions forced during implementation

Three more choices had to be made once the code existed. They were not
in the plan's open questions but would have been silent behavior
otherwise.

### The pull target is the source's change head

The plan said to capture the target from `watermarks({ settle: true })`
without naming a field. That response carries three values, and
`fetchCursor` is the *source's own inbound cursor* — what it has pulled
from us. Using it makes every pull a no-op, because a source that has
never pulled reports zero.

The target is `currentRev`: the head of what the source has produced.
`settle: true` additionally flushes writes still buffered in the
userspace shim, so they fall inside this target instead of waiting for
the next operation.

### Object bytes are staged, not carried in memory

`applyChanges` accepts a map of chunk bytes, and the obvious
implementation fills it from the transfer. That makes a block's peak
memory proportional to its payload, which defeats the point of a byte
bound. Bytes are instead staged into the content-addressed blob store
as they arrive and the apply reads them back from there, so a block's
resident cost is its metadata.

Staging before apply is also what makes a mid-block crash replay
cleanly rather than fail on a missing object.

### The mutation FIFO is held per block, not per iteration

`Workspace` serializes mutating sync through a per-backend FIFO. Taking
that lock for a whole iteration would block every other mutation for as
long as the caller took to return to the iterator — and the entire
premise of the design is that the caller may never return. The lock is
therefore taken and released per `next()`.

This preserves "one mutating sync block per backend and direction"
while making an abandoned iterator harmless. It does mean two blocks of
one logical operation can be separated by unrelated mutations, which is
already true across an eviction and is what the fixed target exists to
tolerate.

## Removing the batch API and the retry scheduler

The plan sequenced the removal of the old public surface after a
compatibility window. There is no shipped consumer, so the window was
skipped and the surface is gone.

**`pull()` and `push()` are the iterables.** The batch overloads,
`SyncBatchOptions`, `SyncBatchBudget`, and `SyncBatchResult` are
deleted rather than deprecated. `pullOnce` and `pushOnce` remain as
internal drivers because the exec bracket needs a single awaitable call
that drains the whole window before a command starts, and an entry
count to report on the execution.

**`retryPendingSync` and `SyncRetryScheduler` are deleted.** They
existed because a failed post-command pull had nowhere durable to
record its progress, so the host persisted an intent, set an alarm, and
called back with a bounded budget and an attempt counter. The operation
row and the watermark now hold exactly that state, and any later
`pull()` resumes from it. Keeping a parallel retry ledger would mean two
sources of truth for the same question.

This also removed the caller-visible retry budget the plan wanted gone.
Exhaustion, backoff, and attempt counts are no longer part of the API;
a caller that wants to stop trying simply stops iterating.

A deferred exec now calls `captureSyncTarget`, which opens the
operation and fixes its target without transferring anything. That
pins the command's changes at the moment it finished, so a later
`pull()` joins the pending operation instead of capturing a newer
target that could have raced ahead.

One behavior changed as a consequence. `onPullPending` used to dial the
backend to record a retry intent; it is now a no-op, because a pull that
failed in-band already left its operation pending. Dialing a fresh
handle purely to write bookkeeping turned a failed command into a
second connection attempt, which a regression test caught.

## Measured behavior

Two benchmark harnesses were added and run in this environment:
`packages/dofs/src/bench/sync-blocks.bench.ts` against real Durable
Object `SqlStorage` under workerd, and
`packages/rpc/src/bench/sync-engine.bench.ts` driving the engine
end to end. Numbers below are from a 16-core dev container, so treat
them as ratios rather than absolutes.

### Small trees hide the CPU risk; install scale exposes it

On a 1350-file tree every block finishes in well under a second, and
the worst case leaves a 36x margin against the 30-second allowance.
That reading is misleading, and acting on it would have shipped a bug.

Run against the size the plan actually cites — 44,100 files, 49,001
entries, close to its reference 44,264 — the picture changes:

| Mode | Entries | Blocks | Wire | Total | Worst block | Headroom |
|---|---:|---:|---:|---:|---:|---:|
| entries | 49,001 | 13 | 47.3 MB | 121.5 s | 15.2 s | 2.0x |
| pack | 49,001 | 13 | 3.5 MB | 122.3 s | 15.8 s | 1.9x |

Both converge (all 44,100 files applied, cursor at target), but the
plan's proposed 4,000-entry block spends 15.8 s of a 30-second
allowance. Under 2x headroom means an unlucky block, a colder cache, or
a slower machine exceeds the limit — and a block that cannot finish can
never finish, because each retry starts from the same cursor and does
the same work. The shrink-on-interruption policy would eventually walk
the profile down, but only after repeated hard failures.

A sweep at install scale shows the cost is superlinear in block size
while total time is flat:

| Block max entries | Blocks | Total | Worst block | Headroom |
|---|---:|---:|---:|---:|
| 500 | 49 | 36.8 s | 2.8 s | 10.8x |
| 1000 | 25 | 29.9 s | 3.6 s | 8.4x |
| 2000 | 13 | 30.5 s | 3.7 s | 8.1x |
| 4000 | 7 | 31.0 s | 8.1 s | 3.7x |

The gain from fewer round trips is exhausted by about 1,000 entries,
while per-block cost keeps climbing. **`DEFAULT_BLOCK_PROFILE.maxEntries`
is therefore 2,000, not the planned 4,000**: the same total time with
more than double the headroom. Blocks are a checkpointing mechanism,
not a throughput knob, so making them bigger buys almost nothing and
costs exactly the property they exist for.

Restarting from a fresh iterable per block costs about 5% over reusing
one iterator, which is the price of the durability guarantee and is
cheap.

### Pack transport is a bandwidth trade, not a free win

This is the finding that most changes the plan's framing. The plan
justified packs on a 172-second full-pack result and treated
compression as strictly better. Measured against an in-process peer,
pack mode is *slower*:

| Shape | Entry mode | Pack mode |
|---|---:|---:|
| small (25 files) | 61 ms | 47 ms |
| medium (540 files) | 305 ms | 370 ms |
| large (1800 files) | 867 ms | 1470 ms |

The cause is gzip CPU, isolated directly: compressing one 512-entry
block's 2.3 MB of records down to 85 KB costs about 170 ms, while the
rest of the block (planning, staging, apply) costs about 100 ms. An
in-process stub charges nothing for bytes, so that CPU buys nothing.

Counting bytes instead of assuming them, for the same 1800-file window:

| Mode | Wire bytes | Local CPU |
|---|---:|---:|
| entries | 6380 KB | 1124 ms |
| pack | 183 KB | 1425 ms |

That is a **35x** reduction in bytes for roughly 300 ms of extra CPU.
Pricing both against a link gives the crossover:

| Link | entries | pack | Winner |
|---|---:|---:|---|
| 10 Mbps | 6109 ms | 1568 ms | pack, by 74% |
| 50 Mbps | 2121 ms | 1454 ms | pack, by 31% |
| 100 Mbps | 1623 ms | 1439 ms | pack, by 11% |
| 500 Mbps | 1224 ms | 1428 ms | entries, by 17% |
| infinite | 1124 ms | 1425 ms | entries, by 27% |

**Pack mode wins below roughly 150 Mbps of effective throughput and
loses above it.** The DO-to-container hop in production is not a local
socket, so packs should win in the deployed shape — but that is now a
stated assumption with a measured crossover, not an unexamined premise.

At install scale the byte reduction is larger and the CPU penalty
smaller, because entry metadata dominates a 49,001-entry window:
47.3 MB on the wire in entry mode against 3.5 MB packed, a **13x**
reduction, for well under 1% extra CPU (121.5 s against 122.3 s). The
crossover there sits near 500 Mbps rather than 150, so the larger the
sync, the more clearly packs are the right choice — which is the shape
the thresholds already select for.

The thresholds stay as they are: 20,000 entries or 100 MiB is far above
where this crossover sits, so any window that trips them is one where
bytes dominate. The pack compression ratio itself is strong on both
shapes measured against real DO storage — 9.1x on a metadata-heavy tree
and 151x on a byte-heavy one.

If the deployed link turns out to be fast enough that packs lose, the
fix is a threshold change and not a redesign, because mode selection is
already a single decision per operation.

## Status

Landed: durable operation state, the block planner, revision-guarded
replay, the pack codec, pack transport in both directions, the pull and
push engines, the `Workspace` iterables, and removal of the batch API
and retry scheduler.

Remaining gaps:

- **Adaptive block growth.** The sizing profile shrinks on interruption
  and resets on completion, but never grows beyond the default. The plan
  asks for instrumentation before adding growth, and that
  instrumentation is not built.
- **Production validation.** Block sizing, restart overhead, the pack
  bandwidth trade, and convergence at the plan's own 44,000-entry scale
  are now measured, the first against real Durable Object SqlStorage.
  What is still missing is the deployed shape: forced eviction between
  blocks and forced disconnect in each transfer phase are covered by
  unit tests but not by a real DO-to-container pair, payloads here are
  38 MB rather than the plan's 1 GB (so per-file bytes, not entry
  counts, remain unexercised), and the effective bandwidth of the
  production hop is unmeasured — which is the input the pack crossover
  depends on.

- **Wall-clock at scale.** Converging 44,100 files takes about two
  minutes in this environment against an in-process peer. That is
  inside no single Durable Object invocation, so a sync this size
  necessarily spans many alarms; the design accounts for that, but the
  end-to-end latency a caller sees has not been measured against a real
  transport.
- **Wire version negotiation.** Pack transport is advertised by method
  presence, which is enough for optional methods but is not a version
  scheme. A future incompatible pack format change would need one.
