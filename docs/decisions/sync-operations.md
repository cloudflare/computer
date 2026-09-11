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

## Status

Landed: durable operation state, the block planner, revision-guarded
replay, the pull engine, the push engine, and the `Workspace`
iterables.

Not yet landed, and deliberately so:

- **Pack mode.** `selectMode` decides entries versus pack and the
  thresholds are tested, but the compressed content-addressed pack
  codec itself is not written; both directions currently run in entry
  mode. The measured 172-second full-pack result is the reason to build
  it, and the block framing it needs is now in place.
- **Removing the old public API.** `pull()` and `push()` keep their
  batch overloads and their exec bracket. The plan sequences that
  removal after a compatibility window, and the command executor still
  depends on the current shapes.
- **Peer capability negotiation.** The plan calls for using block
  methods "only when the connected peer exposes them", but the wire has
  no version negotiation today. The engine rides the existing
  `fetchChanges` / `push` methods precisely so it needs none; a
  dedicated block method would need that negotiation designed first.
