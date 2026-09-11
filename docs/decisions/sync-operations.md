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
