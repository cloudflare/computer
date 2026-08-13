# 02. Sync Protocol

> [!NOTE]
> This document tracks the shipped wire shape in `packages/dofs/src/sync/*`
> and `packages/rpc/src/{interface,server,sync-driver}.ts`. A handful of
> claims describe deferred work; those are marked inline. When code and
> doc disagree, code wins — file a fix against whichever side is wrong.

The workspace keeps two copies of the filesystem tree in sync:

- **DO side** — a SQLite-backed VFS in the Durable Object (the source of
  truth across restarts). See [03. Filesystem Schema](./03_filesystem_schema.md).
- **Container side** — a VFS exposed to the sandbox via a FUSE mount at
  the configured workspace root. The container store is the same
  `Database` abstraction used DO-side; whether it persists across
  container restarts is a deployment choice (today's `computerd` runs against
  a process-lifetime DB, so a container restart loses local state and
  the next push from the DO re-baselines it).

Sync is incremental and bidirectional. Each side carries a monotonic
counter so neither has to send the whole tree to catch up.

## Lifecycle

Data flows in two directions, on its own clock:

- **DO → container (push).** Every DO-side mutation is stamped with a
  fresh revision. When the container needs them — before an `exec()`,
  or on an explicit `workspace.push()` — the DO sends every revision
  the container hasn't seen yet.
- **Container → DO (pull).** Every container-side write through FUSE is
  stamped with a fresh container revision. The DO collects those
  revisions — after an `exec()` returns, or on an explicit
  `workspace.pull()` — and applies them to its SQLite store.

A typical `exec()` round-trip:

1. **Push.** The DO streams every `ChangeEntry` with a higher
   revision than the container has seen, **coalesced to one entry
   per path** (the latest state wins — five rewrites of the same
   path between execs cost one entry on the wire, not five). A
   hardlinked inode carries several names: `coalesceChanges` emits
   one entry **per name**, so every path materialises on the
   receiver. Hardlink identity is not preserved across the wire —
   each name becomes an independent file with the same content, not
   a shared inode. Bytes
   are not inline; entries carry chunk hashes only. The **sender**
   (the DO) calls `remote.hasObjects(...)` on the referenced hashes
   and follows up with `remote.pushObjects(missing)` for the subset
   the receiver doesn't already have. After the receiver applies
   the batch, the DO advances `pushRev` past the rev it just sent
   — but only when there were no unpushed local writes interleaved
   in the meantime, so an apply that races a local mutation doesn't
   strand the local write. This post-apply `pushRev` advancement
   (introduced in `dc692c0`) is what keeps the container's own apply
   from bouncing the same entries straight back on the next pull.
2. **Hydrate.** Lazy-mount stubs the command might touch are fetched
   from their providers and included in the same push batch. See
   [06. Mount Interface](./06_mount_interface.md).
3. **Exec.** The command runs. FUSE writes are captured by the
   in-container VFS as they happen, each stamped with a fresh revision.
4. **Fetch.** The DO calls `fetchChanges({ after: fetchCursor })`.
   The container streams `ChangeEntry` records after that `(rev, path)`
   cursor — one per touched path, per-file entries carrying
   `chunks: (hash, size)[]`. No bytes inline.
5. **Diff.** The DO reads up to `PULL_BATCH_SIZE` (256) entries from the
   stream, unions the chunk hashes referenced by that batch, probes
   its own `vfs_blobs` for which it already has, and calls
   `fetchObjects` for the missing subset.
6. **Apply.** Entries + new objects land in the DO's SQLite. Peak
   memory in `pullOnce` is bounded by `PULL_BATCH_SIZE` entries plus
   the bytes the batch references — the entry stream is never buffered
   whole. Each batch runs through `applyChanges`, whose per-mutation
   `transactionSync` inside `writeFile`/`mkdir`/`rm`/`symlink` is the
   real durability boundary. The driver then loops back to step 5 for
   the next batch.
   The fetch cursor is advanced **per committed batch** to the last
   streamed entry's `(rev, path)`. `coalesceChanges` emits entries in
   ascending `rev`, then ascending `path`, so this checkpoint is safe
   even when one rev contains more than one batch. A crash mid-pull
   resumes from the last per-batch advance, so re-fetched work is
   bounded by `PULL_BATCH_SIZE` (256) entries, not the whole stream.
   The receiver's `alreadyApplied` check inside `applyChanges` still
   drops already-applied entries on the floor so re-apply is
   idempotent and cheap.

`writeFile` / `mkdir` / `rm` outside of `exec()` follow the same shape:
step 1 is "this single change", steps 3–6 are skipped. `workspace.push()`
runs step 1 on demand; `workspace.pull()` runs steps 4–6.

Renames are local inode moves, but the sync wire has no rename opcode.
The wire stays final-state based — live entries plus tombstones — so
apply remains idempotent and does not need operation-order replay. The
cost is that a directory rename stamps every moved inode with one new
revision and records tombstones for the old paths in one synchronous
transaction. Large directory renames are therefore O(subtree) in local
writes and wire entries, with no separate cap beyond the caller's own
workload. Parent directory mtimes are not changed by rename, which
differs from POSIX `rename(2)` but keeps parent directory metadata out
of content sync.

Directory entries carry mode and mtime. New directories are created
with the incoming mtime, but idempotence for an existing directory is
mode-only. That keeps mtime drift on matching directories from
becoming sync traffic.

When an upstream file, directory, or symlink lands where the receiver
has a different node type, the receiver removes the local node tree and
applies the upstream entry. This is last-writer-wins conflict handling:
it converges the tree, but local-only children under the conflicting
path are discarded without separate tombstones.

## Alternatives considered

Representing a rename as a full-subtree restamp produces one wire entry
per subtree item at a single revision. Two cheaper encodings were
considered and rejected.

### A rename opcode

A dedicated `rename` entry carrying `{ fromPath, toPath, inode }` would
collapse a directory move to one wire row. It was rejected because it is
an operation, while the rest of the protocol is state-based:
`materialiseChange` resolves each entry to the path's current state at
fetch time, the receiver reconciles against its own live state, and
`alreadyApplied` makes re-apply idempotent without ordered replay.

An opcode breaks that model in three ways. It is relative to the
receiver's prior state: `relink(from -> to)` is meaningless to a peer
that never held `from`, so a cold-start peer pulling from rev 0 has
nothing to relink. The pull path is deliberately receiver-history
agnostic: the producer answers "changes after cursor X" by
materialising current state and knows nothing about what a given
receiver has seen, so it cannot decide when an opcode is safe to emit.
And making the opcode idempotent against final state requires
re-deriving the same state reconciliation the opcode was meant to avoid,
while still not solving cold start. The per-subtree cost is the price of
keeping one state-based representation that bootstraps, converges, and
replays under a single rule.

### Chunking a rename across revisions

A scalar fetch watermark can only resume at revision boundaries, so a
large rename at one rev forces a crash to replay the whole rev. One way
to bound that without a path cursor is to split a single rename across
many revisions, so a scalar watermark resumes at a chunk boundary.

This was rejected because it weakens an invariant the protocol relies
on: `rev` is bumped atomically once per mutation (see
[03. Filesystem Schema](./03_filesystem_schema.md)), so every `rev`
value names one committed point in the mutation log. Chunking would
mint intermediate revisions that never committed as a whole, leaving
most `rev` values describing tree states that never existed.

The `(rev, path)` fetch cursor avoids that. `path` is an orthogonal
second coordinate that records resume progress within a rev. A rename
still stamps exactly one revision across its subtree, while a crash can
resume mid-rev. Resumability is bought without minting phantom
revisions.

**What a cursor guarantees.** A `(rev, path)` cursor is a *resume
point*, not a snapshot handle. `{rev, path: null}` means "every change
committed at or before `rev` has been offered to the receiver"; a
non-null `path` means "offered up to `path` within `rev`." It is
deliberately not a point-in-time snapshot read: `coalesceChanges`
materialises each path's *current* state at stream time, because the
store keeps no content history. A path that is rewritten or deleted
again after a snapshot opens has its live rev pushed past the
advertised `currentCursor`, so that entry is dropped from the current
stream and redelivered under a later cursor. The receiver's tree at
cursor `{5, null}` therefore need not byte-match the rev-5 snapshot for
a path that raced ahead — but convergence holds, because the rev that
caused the drop is greater than `currentCursor.rev`, so the next pull
re-scans and delivers the path's then-current state. The cursor never
advances past the rev that would redeliver an omitted path.

### Chunking

Files are split at a fixed `CHUNK_SIZE` (512 KiB). Chunk boundaries are
deterministic — `chunkIdx = floor(byteOffset / CHUNK_SIZE)` — so an edit
that only touches one region of a large file pulls back only the
affected chunks instead of the whole file. Each chunk is content-
addressed by `sha256(bytes)`, so:

- Duplicate content (the same library vendored at two paths, an edit
  that only rewrites the last chunk) is transferred and stored once.
- The "what bytes do you actually need?" probe is just a set
  difference of 32-byte hashes — no metadata round-trips.

## Watermarks

Both sides carry monotonic revision counters and exchange them on every
push and pull. The wire vocabulary is `rev` throughout — one concept,
one name.

| Watermark | Owner | Meaning |
| --- | --- | --- |
| `pushRev` | DO | Last DO-side `rev` successfully pushed to the container. |
| `fetchCursor` | DO | Last container-side cursor the DO has fetched; `path = null` means every change committed at or before that rev has been offered (a resume point, not a point-in-time snapshot — see above). |
| `currentRev` | DO | Latest `rev` stamped on a DO-side mutation. |
| `currentRev` | Container | Latest `rev` stamped on a container-side mutation. |
| `appliedPushCursor` | Container | DO-side cursor the container has applied. Echoed on every **push** and **fetchChanges** response. |

The DO watermarks live in the `_vfs_watermark` table so they survive DO
restarts. The container's watermarks live in the same `Database`
abstraction; whether they survive a container restart is a deployment
choice. Today's `computerd` runs against a process-lifetime DB, so a container
restart loses local watermarks and the next push from the DO is treated
as an authoritative baseline (the `senderRev === 0` branch below covers
the symmetric case where an external orchestrator writes against a
fresh receiver).

### Cross-side invariant

After every successful `push` **and** every `fetchChanges`, the
response carries the receiver's current `appliedPushCursor`. The DO
asserts that cursor covers its local `{ rev: pushRev, path: null }`
before continuing. The two sides never share a single clock, but
echoing the applied cursor makes the "receiver is caught up with our
pushes" invariant inspectable on the wire instead of load-bearing
in-process state. A regression in the post-apply cursor advancement
path trips the assertion on the next push or pull rather than
corrupting data silently.

## Wire shape

The wire is symmetric: push and fetch both move `ChangeEntry`
records, both probe with `hasObjects`, both transfer bytes by hash.
Naming follows git's vocabulary — the DO *pushes* entries and
objects to the container, and *fetches* entries and objects back.

The DO and `computerd` are deployed as a matched pair. The protocol has no
version negotiation, so changes to request or response shapes are hard
wire breaks and require lockstep rollout.

| RPC | Direction | Returns | Notes |
| --- | --- | --- | --- |
| `push({ senderRev, changes })` | DO → container | `{ rev, appliedPushCursor }` | Streams a coalesced batch of `ChangeEntry` via the `changes` `ReadableStream`. The sender then calls `hasObjects` on the referenced hashes and follows up with `pushObjects` for the missing subset. See the `senderRev` branches below. |
| `fetchChanges({ after?, ignore? })` | container → DO | `Promise<{ currentCursor, appliedPushCursor, stream: ReadableStream<ChangeEntry> }>` | Streams one entry per touched path after `after`, ordered by `rev` then `path`. For files, `chunks: (hash, size)[]` (no bytes inline); for dirs, metadata; for deletes, a tombstone. `currentCursor` is `{ rev: currentRev, path: null }` at stream open; the puller writes it after a clean drain. `appliedPushCursor` carries the cross-side invariant check on the pull path. |
| `hasObjects(hashes[])` | sender probes receiver | `Uint8Array[]` | Returns the subset of the input the receiver already holds. The git `have` line, batched. |
| `fetchObjects(hashes[])` | container → DO | `ReadableStream<{ hash, bytes }>` | Streams chunk bytes by hash. The git `want`/pack response on the fetch path. |
| `pushObjects(objects)` | DO → container | `void` | Streams chunk bytes by hash. The push-direction mirror of `fetchObjects`. |

### `senderRev` semantics on `push`

`push` is called by two kinds of writers and the `senderRev` field
discriminates them (see commits `dc692c0` and `c95c74d` for the
load-test rationale):

- **`senderRev > 0` — sync peer.** A DO calling its container counterpart
  (or vice versa). The receiver applies the batch as `upstream`,
  advances its own fetch cursor to `{ rev: senderRev, path: null }`,
  and on the *sender's*
  side `pushRev` is advanced past the rev just shipped (gated on no
  interleaved local writes — see step 1 above).
- **`senderRev === 0` — external writer / fresh receiver.** Used by
  external orchestrators (and as the implicit shape when a fresh
  receiver has no watermarks yet). The receiver applies as `local`,
  bumps its own `currentRev` per entry, and leaves its outbound
  watermarks alone so the next sync loop ships the new entries
  onward. Without this branch the receiver would silence its own
  outbound sync after an external write — see `c95c74d`.

Identical content at multiple paths (or unchanged chunks within an
edited file) shows up exactly once on the wire. See
[08. Capnweb Interface](./08_capnweb_interface.md) for the framing.

## Failure handling

- **Container restart or transport loss.** The Durable Object detects the closed WebSocket, removes and closes the stale backend handle, and reconnects through the normal computerd health gate. `pushOnce` and `pullOnce` get one reconnect retry inside the original logical operation. `pushRev` and the fetch cursor make those retries idempotent: a torn push replays entries whose watermark did not advance, while a torn pull resumes after its last committed batch. A fresh process-lifetime computerd database resets the matching local watermarks before the replacement handle is exposed, so the next push rebuilds it from a rev-0 baseline.
- **Container restart during command execution.** The pre-exec push must succeed, including its reconnect retry, before `shell.exec` is called. A locally disposed stub proves that a spawn request was never sent and permits one reconnect retry. A generic disconnect after dispatch is ambiguous, so the backend invalidates the handle and reports that the command may have started instead of replaying it. Event-stream failures follow the same no-replay rule. The post-command pull remains safe to retry; if it still fails, the execution result reports pending sync and the optional durable retry scheduler can resume the pull without rerunning the command.
- **Container crash mid-apply.** `push` is atomic from the DO's
  perspective on the receiver: the server wraps the whole batch in a
  single `db.transactionSync` via the synchronous `applyChangesSync`
  helper. `Database.transactionSync` is reentrant via SQLite SAVEPOINTs
  so the inner fs writes still get their own per-mutation atomicity
  inside the outer transaction. A mid-stream failure (e.g. a missing
  chunk in the assembly step) rolls back every entry the batch had
  applied so far; the receiver never sees a partial push. The pull
  path keeps the per-mutation model because the streaming batches
  can't hold a synchronous transaction across network I/O.
- **DO restart mid-pull.** The fetch cursor advances per committed
  batch to the last entry's `(rev, path)`, so a restart mid-pull
  resumes from the last per-batch checkpoint, including within a
  single large rev. Wasted work is bounded by `PULL_BATCH_SIZE`
  entries (256), not the whole stream. End state is correct either
  way — apply is idempotent.
- **DO restart.** Watermarks are persisted, so the new DO instance
  picks up where the old one left off. The container keeps `computerd`
  alive across the gap.
- **Concurrent mutators.** `Workspace.push()` and `Workspace.pull()`
  go through a per-Workspace tail-promise FIFO. Two concurrent
  callers queue — the second can't enter `pushOnce` / `pullOnce`
  until the first has resolved or rejected. A command's pre-exec push
  and post-stream pull each use this facade, but the FIFO is not held
  for the command's lifetime: overlapping commands and explicit sync
  calls are not one transaction. Rejections aren't contagious: a
  failed mutation surfaces its error to its own caller without
  poisoning the queue for the next. Pure reads on `Workspace.fs`
  bypass the FIFO entirely — they hit the local SQLite store, which
  the DO runtime already serialises internally through its input gates.

## Conflict semantics

A *conflict* arises when two writers both mutate the same path without
seeing each other's change first. Understanding where conflicts can and
cannot happen in `@cloudflare/computer` is essential before reasoning
about the guarantees the system provides.

### Within a single Workspace instance (DO)

All mutations on a single `Workspace` instance (a single DO
incarnation) are serialised by the DO runtime's input gates. Two
concurrent calls to `ws.fs.writeFile` on the same path queue against
the same SQLite store and resolve in order. There is no write-write
conflict possible within one DO instance — the last call to land in
the input gate wins and that is the authoritative state.

The per-`Workspace` tail-promise FIFO adds a second layer of
serialisation for `push()` and `pull()`: a concurrent pair of callers
that both trigger sync operations will queue at the FIFO before either
enters `pushOnce` / `pullOnce`. The push and pull phases of
`runtime.exec()` use that FIFO independently; the running command does
not hold it.

### Across two containers sharing one Workspace

This is where conflicts can occur. If two containers (two separate
`computerd` mounts or two separate `WorkspaceBackend` instances) are wired
to the same DO and both write to the same path, the outcome depends
entirely on sync order:

1. The sync protocol always **pulls remote changes before pushing
   local ones** (`tick()` = pull then push). This prevents a writer
   from clobbering the remote state with a stale local copy — it first
   absorbs whatever the remote already has.
2. However, **the pull does not detect that a path changed both
   locally and remotely since the last sync**. When two containers
   edit the same file concurrently, whichever container's push arrives
   at the DO *last* wins. The earlier writer's change is silently
   overwritten on the next sync. There is no merge, no error, and no
   indication to either caller that a conflict occurred.
3. Object-level integrity is preserved: the DO never holds a
   partially-applied write. But content-level integrity is *not*
   guaranteed — the surviving content is simply the last batch that
   was applied.

This is **last-write-wins at the sync granularity**. It is the same
semantics as a shared NFS mount without locking, or an S3 bucket
without conditional PUTs.

### When last-write-wins is safe enough

For the common agent patterns this is usually fine:

- **One agent, one container, one DO.** No concurrent writers. Sync
  is effectively a durability mechanism, not a concurrency mechanism.
  This is the vast majority of current usage.
- **Multiple agents, disjoint path ownership.** If agent A always
  writes under `/workspace/a/` and agent B always writes under
  `/workspace/b/`, their writes never overlap. Conflicts are
  structurally impossible regardless of sync order.
- **One writer, multiple readers.** Multiple consumers pulling from
  the same DO but only one pushing. Conflict-free by construction.
- **Write-once files.** Config files, initial scaffolding, or
  generated artefacts that are written once and then only read.
  Once the file lands in the DO it is stable; sync order is
  irrelevant.

### When last-write-wins is not safe enough

Patterns that can lose data today:

- **Multiple agents writing to shared files.** A shared `PLAN.md`, a
  shared `state.json`, a shared log — any file that two containers
  update independently will converge to whichever version synced
  last, silently discarding the other.
- **Read-modify-write cycles across containers.** If container A
  reads `counter.txt` as `5`, increments to `6`, and writes it back,
  while container B also read `5`, incremented to `6`, and writes it
  back, the DO ends up with `6` from one of them, not `7`. Neither
  write errored.
- **Agent handoffs without an explicit sync point.** If agent A
  finishes work and agent B immediately picks up the same workspace,
  B needs to call `workspace.pull()` explicitly before reading to
  ensure it sees A's final writes — there is no automatic fence.

### Practical guidance today

Given the current guarantees, the safest patterns are:

1. **One active writer per workspace at a time.** If you have multiple
   agents, coordinate via explicit handoffs at the application level
   (e.g. agent A calls `workspace.pull()` at the end of its turn;
   agent B calls `workspace.pull()` before starting its turn).
2. **Partition the namespace.** Give each agent a dedicated subtree.
   Shared state lives in the DO via its own RPC surface, not as a
   shared workspace file.
3. **Treat workspace files as agent-local scratch, not shared
   mutable state.** The workspace is good at durable per-agent
   storage. It is not (yet) a shared CRDT.

See [Future considerations](#future-considerations) for the planned
first-class conflict primitives.

## Ignore lists


The `ignore` option hides path segments from the pull. Excluded
paths are still written and read inside the container — the bytes just
never cross the wire back to the DO. This is essential for any large
directory of derived files: `node_modules`, `.next`, `target`,
`__pycache__`, `dist`. Without an ignore, a single `npm install` would
push tens of thousands of small files through the sync wire on the
next pull.

The default is `["node_modules"]`, applied server-side when `ignore` is
omitted. A caller-supplied list **replaces** the default — it does not
extend it. Pass `[]` to disable ignoring entirely, or pass your full
list (including `"node_modules"` if you still want it) to customise.

### Ignored entries

Ignored paths are **invisible to the `Workspace.fs` API**. They do not
appear in `readdir`, `stat` returns `ENOENT`, and `readFile` returns
`ENOENT`. The bytes still live inside the container, so anything that
*uses* the ignored files — `exec("node ...")`, build tools, anything
running container-side — keeps working. The exclusion only affects what
crosses the wire **and** what the DO-side API surfaces.

This is a deliberately narrow surface for the initial release. Whether
ignored entries should be representable to the DO at all (as stubs, as
a separate shell-only namespace, or not at all) is left to a future
iteration — see [Future considerations](#future-considerations).

## Future considerations

Items deferred from the initial design. File an issue if a real use
case depends on a particular resolution.

### Representing ignored entries to the DO

Today ignored paths are entirely invisible to `Workspace.fs`. That is
the simplest contract but it loses one piece of information: tools that
want to enumerate "everything the agent's exec can see" can't get it
from the DO. Two options worth weighing later:

- **Stub entries with an `ignored` flag** on `stat()`, surfaced via
  `readdir`. Easy to retrofit; surprising for tools that walk the tree
  and don't check the flag.
- **An explicit shell-only namespace** — e.g. `workspace.runtime.readdir`
  returns container-only entries, `workspace.fs.readdir` stays clean.
  Cleaner separation, larger API surface.

Either way, the bytes never cross the wire; the question is purely how
much the DO admits exists.

### Bloom/cuckoo filter over `vfs_blobs.hash`

Every pull does a `hasObjects` probe round-trip. With tens of thousands
of chunks per pull the bytes are small but the latency is real. A DO-
side probabilistic filter rebuilt lazily from `vfs_blobs` would let the
DO skip the probe for chunks it can prove it doesn't have, falling
back to `hasObjects` only for likely-present hits. No protocol change
needed; pure DO-side optimisation.

### Push backpressure

A long-running exec can dirty container state faster than the DO can
pull. Today's process-lifetime container VFS caps this by OOMing, which
is a bad answer. Once a disk-backed container mirror lands the bound
shifts to path count, but the same problem persists. Likely shape: a
soft cap on the dirty set (say, 256 MiB pending bytes or 100k paths)
above which FUSE write replies are delayed (real backpressure into the
writer), or the container opportunistically initiates a push to the DO
out-of-band rather than waiting for the post-exec pull.

### Prior art and selective reuse

The chunk store + per-file manifest + haves/wants negotiation pattern
is not novel — git, casync, OSTree, restic and IPFS unixfs all solve
variants of the same problem. Reusing one of them outright would
trade implementation we control for a library mismatch we don't.
Reusing the *formats* and *patterns* without the libraries is the
better trade for our scale.

**Git pack protocol.** Maps directly onto our model: trees =
directories, blobs = files, content addressing by sha. The smart
protocol's haves/wants negotiation is exactly what `hasObjects` /
`fetchObjects` do today, and isomorphic-git is already in the dependency
tree for `GitHubRepo`. Where it stops fitting: git's chunking is
per-blob (whole file), so sub-file dedup costs a repack-driven delta
search rather than falling out of the addressing. Its mental model is
history — every push would be a synthetic commit and GC would need
repack cycles. Its metadata model is poor (executable bit only). The
binary pack format loses capnweb-text's debuggability. Verdict: *borrow
the haves/wants pattern and the naming, not the library or the wire
format.*

**casync.** The closest fit: built by Lennart Poettering for exactly
this problem. The `.caidx` chunk-index format is an ordered list of
`(sha256, offset, size)` per file — our `vfs_manifests.encoded` is
a homebrew of the same shape. The `.castr` chunk store is our
`vfs_blobs`. Buzhash content-defined chunking solves the
head-insertion problem in this appendix. Full POSIX metadata
(symlinks, hardlinks, xattrs, mode, mtime) is built in. The blocker
is implementation: casync is C, the only good port is Go (`desync`),
and a production-grade TypeScript implementation does not exist. A
WASM build is possible but the carrying cost is larger than our
current sync implementation.

**OSTree, restic, borg, IPFS unixfs.** All have the right data shape
but the wrong centre of gravity — OS images, backup snapshots, or a
full P2P network stack. None has a clean TypeScript runtime story for
a DO. Worth knowing about; not worth pulling in.

**Where to spend the reuse budget**

Three concrete borrows give us most of the upside with no runtime
dependency:

1. **Adopt casync's `.caidx` format as our manifest encoding.** Our
   current encoding is already structurally identical; switching to
   the published spec costs nothing and we gain free debuggability
   (`casync mtree`, `desync index` on the file from any container)
   and trivial export of a workspace as `.caidx` + `.castr` for
   backup or migration. Spec borrow, not code borrow.
2. **The `hasObjects` / `fetchObjects` RPCs already align with git's
   haves/wants
   vocabulary** — anyone who has read `git fetch` source recognises
   the pattern instantly. The semantics are already the same; this
   is purely a naming alignment.
3. **When content-defined chunking lands (see above), vendor a
   FastCDC / buzhash implementation rather than rolling our own.**
   The algorithms are subtle (boundary stability, min/max bounds,
   rolling-hash window selection) and good MIT-licensed TS ports
   exist. This is the one place where reinventing the wheel hurts.

**Where to *not* spend it**

- Don't take `isomorphic-git` as the sync engine. The history model
  fights the live-tree model on every push.
- Don't take `libcasync` (or a WASM build) as a runtime dep. The
  protocol surface we maintain is ~6 RPCs and a few hundred lines of
  logic; replacing it with a library mismatch is a net loss at our
  scale.
- Don't adopt IPFS CIDs / multihash. The indirection buys nothing
  inside a single DO + container pair.
