// Bidirectional sync driver. Pairs a local Database with a remote
// SyncRPC stub and runs pull + push ticks against the wire.
//
// Both sides of the prototype use the same driver: the container
// (computerd) drives an upstream DO stub, and once the DO has a real
// runtime it'll drive a container stub the same way.
//
// The driver doesn't own a timer. The caller decides when to call
// `pullOnce()` and `pushOnce()` \u2014 a polling loop in production,
// a manual `tick()` in tests so convergence is deterministic.

import {
  type ApplyResult,
  applyChanges,
  assertAppliedPushCursor,
  type ChangeCursor,
  type ChangeEntry,
  coalesceChanges,
  compareChangeCursors,
  currentRev,
  type Database,
  hasObjects,
  readFetchCursor,
  readWatermark,
  type SkippedEntry,
  stageBlob,
  writeFetchCursor,
  writeWatermark,
} from "@cloudflare/dofs";

import type { SyncRPC } from "./interface.js";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// Best-effort dispose of a capnweb result envelope. Real envelopes
// expose [Symbol.dispose]; the test fakes return plain objects, so
// the symbol may be absent.
function maybeDispose(value: unknown): void {
  const d = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  if (typeof d === "function") d.call(value);
}

// Soft cap on entries processed per batch in pullOnce. Each batch
// runs hasObjects + fetchObjects + applyChanges against the entries
// it just buffered, then releases them before reading the next.
// Peak memory in pullOnce is O(PULL_BATCH_SIZE), not O(stream).
const PULL_BATCH_SIZE = 256;

// Pull every entry the remote has produced since the last successful
// pull, apply locally, advance the fetch cursor. Returns an `ApplyResult`
// folded across every batch so callers see both the applied count
// (decide whether to tick again) and any entries skipped because
// they targeted a read-only mount root (surface to the user).
//
// Bytes the receiver already holds (vfs_blobs.hash present) are
// skipped on the wire; the hasObjects probe is what makes that
// dedup work without per-chunk round-trips.
//
// The entry stream is drained in batches of PULL_BATCH_SIZE so peak
// memory stays bounded on a large tree. The durable fetch cursor
// advances after each committed batch to the last streamed entry's
// (rev, path), so a retry can resume inside a single large rev. The
// cursor is read and written per backend so concurrent backends keep
// independent resume points.
//
// `writable: false` pulls the entries and refuses all of them. The
// stream is still drained so the caller learns what the remote tried
// to send, reported as skipped entries with reason no-write-access.
// This is the only enforcement point available against a remote that
// keeps its own copy of the files: it has already written to that
// copy by the time we hear about it.
export async function pullOnce(
  db: Database,
  remote: SyncRPC,
  backend?: string,
  options?: PullOptions,
): Promise<ApplyResult> {
  // Delegate to the inner implementation with retried=false. See
  // pullOnceImpl for the fetchChanges round trip, invariant check,
  // reset-and-retry path, and batched apply loop.
  return pullOnceImpl(db, remote, backend, false, options?.writable ?? true);
}

export interface PullOptions {
  // Whether this pull may write to the local store. Defaults to
  // true. A pull without write access applies nothing.
  writable?: boolean;
}

// Inner pullOnce that knows whether it is already a retry. The
// outer pullOnce always enters with retried=false; on a watermark
// divergence we reset cursors and recurse once with retried=true.
// A second divergence after the reset is a real protocol break,
// not a recoverable race, so we throw to surface it.
async function pullOnceImpl(
  db: Database,
  remote: SyncRPC,
  backend: string | undefined,
  retried: boolean,
  writable: boolean,
): Promise<ApplyResult> {
  const after = readFetchCursor(db, backend);
  const localPushRev = readWatermark(db, "pushRev", backend);
  // fetchChanges hands back the remote's currentCursor (cursor we
  // advance to after a clean drain), its appliedPushCursor (cross-side
  // invariant check on the pull path), and the entry stream itself.
  // One round-trip instead of the previous currentRev() +
  // fetchChanges() pair.
  //
  // pullOnce owns the fetchChanges result envelope: it wraps a stream
  // stub that sits in the exports table until disposed. The stream is
  // fully consumed within this call (drained, cancelled, or abandoned
  // on a throw), so a try/finally disposing the envelope covers every
  // exit — the clean drain, the early-complete return, the cross-side
  // invariant trip, and any throw inside the batch loop. Disposing the
  // envelope tears down the contained stream stub, releasing the
  // remote iterator.
  const fetchResult = await remote.fetchChanges({ after });
  try {
    const { currentCursor, appliedPushCursor } = fetchResult;
    // Cross-side watermark divergence. Two shapes are recoverable:
    //   * appliedPushCursor.rev < localPushRev: the remote forgot
    //     what we pushed (typically a process-lifetime computerd restart
    //     while the WebSocket survived, so reconcileWatermarks on
    //     connect never re-ran).
    //   * currentCursor < after: the remote's log is shorter than we
    //     remember — same root cause, different symptom.
    // Both are the inline equivalent of reconcileWatermarks: reset
    // the divergent cursor to 0, cancel the in-flight stream, and
    // retry once. The rev-0 baseline path in fetchChanges + pushOnce
    // re-ships everything incrementally and the receiver's
    // alreadyApplied() check absorbs the redundant work.
    //
    // The divergence test is rev-only on purpose. A same-rev partial
    // appliedPushCursor (the remote applied part of the rev we
    // pushed, then tore down mid-apply) is not a recoverable race —
    // it means the receiver lost state inside a rev it told us it
    // had. Resetting and replaying cannot mend that, so we let the
    // assertion below surface it instead of looping.
    //
    // A second divergence after a reset is a real protocol break:
    // surface it via the assertion below rather than loop.
    const pushDiverged = appliedPushCursor.rev < localPushRev;
    const fetchDiverged = compareChangeCursors(currentCursor, after) < 0;
    if (!retried && (pushDiverged || fetchDiverged)) {
      // Cancel the stream before disposing the envelope. For a real
      // capnweb envelope the dispose alone is enough to tear down the
      // backing stub, but the in-process server returns a plain
      // ReadableStream wired to an async generator; without an
      // explicit cancel the generator stays advanced (queue size 0
      // plus high-water mark 1 means pull() has already been called)
      // and its query results sit in memory until GC. Cancel is
      // best-effort: a real envelope may have already torn the stream
      // down before we get here.
      await fetchResult.stream.cancel().catch(() => {});
      // Surface the divergence at debug level so an operator with
      // log access can spot a persistently broken remote. We do not
      // throw: a one-shot divergence is normal after a computerd restart
      // under the same WebSocket, and the inline reset + retry is
      // the intended recovery. A persistently-lying remote will log
      // this on every pull, which is the operational signal that
      // something upstream is wedged.
      console.debug("[pullOnce] cross-side watermark divergence; resetting and retrying", {
        backend,
        appliedPushCursor,
        localPushRev,
        currentCursor,
        after,
        resetPushRev: pushDiverged,
        resetFetchCursor: fetchDiverged,
      });
      if (pushDiverged) {
        writeWatermark(db, "pushRev", 0, backend);
      }
      if (fetchDiverged) {
        writeFetchCursor(db, { rev: 0, path: null }, backend);
      }
      return pullOnceImpl(db, remote, backend, true, writable);
    }
    // After the retry path above, this assertion guards a
    // divergence that survived a reset. Tear down rather than loop.
    //
    // Cross-side invariant, symmetric to the push response check: the
    // remote must have applied at least everything we claimed to push.
    // A gap means apply lost state on the receiver; tear down and
    // rebuild rather than corrupt watermarks. Runs inside the try so a
    // trip still disposes the envelope.
    assertAppliedPushCursor(appliedPushCursor, { rev: localPushRev, path: null });
    if (cursorComplete(after, currentCursor)) {
      return { applied: 0, skipped: [] };
    }

    const reader = fetchResult.stream.getReader();
    let totalApplied = 0;
    const totalSkipped: SkippedEntry[] = [];
    let streamDone = false;
    try {
      while (!streamDone) {
        // Read up to PULL_BATCH_SIZE entries before processing the batch.
        const batch: ChangeEntry[] = [];
        const wantedHashes: Uint8Array[] = [];
        const seenHash = new Set<string>();
        while (batch.length < PULL_BATCH_SIZE) {
          const { value, done } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          batch.push(value);
          if (value.kind === "file") {
            for (const c of value.chunks) {
              const k = hex(c.hash);
              if (!seenHash.has(k)) {
                seenHash.add(k);
                wantedHashes.push(c.hash);
              }
            }
          }
        }
        if (batch.length === 0) break;

        // Probe + fetch missing chunk bytes for just this batch. Bytes
        // the receiver already holds (or the remote doesn't have) are
        // skipped, so the per-batch network cost is bounded.
        //
        // Skipped entirely without write access. stageBlob writes to
        // the local store, so fetching bytes for entries we are about
        // to refuse would write through the capability this pull does
        // not have — and pay for the transfer to do it.
        if (writable && wantedHashes.length > 0) {
          const haveSubset = await remote.hasObjects(wantedHashes);
          const remoteHasLocally = new Set<string>();
          for (const h of haveSubset) remoteHasLocally.add(hex(h));
          const localHave = new Set(hasObjects(db, wantedHashes).map(hex));
          const missing = wantedHashes.filter((h) => {
            const k = hex(h);
            return remoteHasLocally.has(k) && !localHave.has(k);
          });
          if (missing.length > 0) {
            // Bare ReadableStream return — no envelope to dispose,
            // capnweb releases the stream stub when the stream itself
            // closes. The reader-loop below drains to completion.
            const bytesStream = await remote.fetchObjects(missing);
            const bytesReader = bytesStream.getReader();
            try {
              while (true) {
                const { value, done } = await bytesReader.read();
                if (done) break;
                stageBlob(db, value.hash, value.bytes, Date.now());
              }
            } finally {
              bytesReader.releaseLock();
            }
          }
        }

        const batchResult = await applyChanges(db, batch, new Map(), {
          source: "upstream",
          backend,
          writable,
        });
        const last = batch[batch.length - 1];
        // Cursor advancement intentionally happens after applyChanges()
        // and is not atomic with it. A crash between apply and this
        // checkpoint re-fetches the batch; upstream apply is idempotent
        // because alreadyApplied() drops entries whose live state
        // already matches.
        //
        // The cursor advances over refused entries too. Refusing is
        // discarding, not deferring: leaving the cursor behind would
        // hand the same writes to the next pull that does have write
        // access, turning a denial into a delay.
        writeFetchCursorIfAhead(db, { rev: last.rev, path: last.path }, backend);
        totalApplied += batchResult.applied;
        if (batchResult.skipped.length > 0) {
          for (const s of batchResult.skipped) totalSkipped.push(s);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Mark the receiver's captured current rev as fully drained. This
    // preserves the ignored/no-op window behavior: if the stream had no
    // entries because every path was filtered out, the next pull still
    // starts after that rev.
    // fetchChanges() is snapshot-bounded by currentCursor, so this
    // final drain marker cannot skip beyond any per-batch cursor written
    // above.
    writeFetchCursorIfAhead(db, currentCursor, backend);
    return { applied: totalApplied, skipped: totalSkipped };
  } finally {
    maybeDispose(fetchResult);
  }
}

function cursorComplete(after: ChangeCursor, current: ChangeCursor): boolean {
  if (current.rev < after.rev) return true;
  return current.rev === after.rev && after.path === null;
}

function writeFetchCursorIfAhead(db: Database, cursor: ChangeCursor, backend?: string): void {
  // Overlapping pulls can complete out of order, so checkpoint writes
  // compare against the latest persisted cursor instead of the value
  // observed when this pull started.
  if (compareChangeCursors(cursor, readFetchCursor(db, backend)) > 0) {
    writeFetchCursor(db, cursor, backend);
  }
}

// Push every entry the local store has produced since the last
// successful push. The wire shape mirrors pullOnce in reverse:
// stage bytes the remote lacks, then push the entry stream.
export async function pushOnce(db: Database, remote: SyncRPC, backend?: string): Promise<number> {
  const sincePush = readWatermark(db, "pushRev", backend);
  const localRev = currentRev(db);
  if (localRev <= sincePush) return 0;

  const entries: ChangeEntry[] = [];
  const wantedHashes: Uint8Array[] = [];
  const seenHash = new Set<string>();
  for await (const e of coalesceChanges(db, { rev: sincePush, path: null })) {
    entries.push(e);
    if (e.kind === "file") {
      for (const c of e.chunks) {
        const k = hex(c.hash);
        if (!seenHash.has(k)) {
          seenHash.add(k);
          wantedHashes.push(c.hash);
        }
      }
    }
  }
  if (entries.length === 0) return 0;

  // Probe the remote for the chunks it already holds; ship the
  // complement.
  const remoteHas = new Set<string>();
  if (wantedHashes.length > 0) {
    const have = await remote.hasObjects(wantedHashes);
    for (const h of have) remoteHas.add(hex(h));
  }
  const missing = wantedHashes.filter((h) => !remoteHas.has(hex(h)));

  if (missing.length > 0) {
    const local = (function* () {
      for (const h of missing) {
        const row = db.one<{ bytes: Uint8Array }>(
          "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
          h,
        );
        if (row === undefined) {
          throw new Error(`pushOnce: missing local blob ${hex(h)}`);
        }
        yield { hash: h, bytes: row.bytes };
      }
    })();
    const bytesStream = new ReadableStream<{ hash: Uint8Array; bytes: Uint8Array }>({
      pull(controller) {
        const next = local.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    });
    await remote.pushObjects(bytesStream);
  }

  const entryStream = new ReadableStream<ChangeEntry>({
    start(controller) {
      for (const e of entries) controller.enqueue(e);
      controller.close();
    },
  });
  const response = await remote.push({ senderRev: localRev, changes: entryStream });

  // Cross-side invariant: the receiver must echo back a cursor that
  // covers the rev we just claimed to push. A drift means the apply
  // path lost data, or a stale receiver is serving an old snapshot.
  // Tear down loudly rather than corrupt watermarks.
  assertAppliedPushCursor(response.appliedPushCursor, { rev: localRev, path: null });

  // Local pushRev advances to the rev we observed at the start of
  // this round. Anything written after that gets caught next tick.
  writeWatermark(db, "pushRev", localRev, backend);
  return entries.length;
}

// One full tick: pull, then push. The order matters \u2014 pulling
// first lets the loopback-suppression in applyChanges absorb
// remote writes before we look at our own dirty set, so we don't
// re-push entries that just came in.
export async function tick(
  db: Database,
  remote: SyncRPC,
): Promise<{ pulled: ApplyResult; pushed: number }> {
  const pulled = await pullOnce(db, remote);
  const pushed = await pushOnce(db, remote);
  return { pulled, pushed };
}

// Reconcile local watermarks against the remote's view of the world.
// Called on (re)connect, before any push or pull tick.
//
// The asymmetry that makes this necessary: the DO's watermarks live
// in durable storage and survive its incarnations, but today's computerd
// runs against a process-lifetime DB so a container restart wipes
// the container-side state. Without a check, pushOnce's early-return
// (`localRev <= sincePush`) skips talking to the container entirely
// when the DO has no new writes — so the next exec runs against an
// empty FUSE mount.
//
// The fix is mechanical: ask the remote what it has, and reset our
// cursors to 0 wherever the remote is behind us. The rev-0 baseline
// path in fetchChanges / pushOnce then re-ships everything
// incrementally on the next tick.
//
// Returns the changes made so callers can log them.
export async function reconcileWatermarks(
  db: Database,
  remote: SyncRPC,
  backend?: string,
): Promise<{ fetchRevReset: boolean; pushRevReset: boolean }> {
  const remoteWatermarks = await remote.watermarks();
  const localFetchCursor = readFetchCursor(db, backend);
  const localPushRev = readWatermark(db, "pushRev", backend);

  let fetchRevReset = false;
  let pushRevReset = false;

  // If the remote's currentRev is below our fetch cursor rev, the remote's
  // log is shorter than we remember — it lost state since we last
  // pulled. Re-baseline from 0.
  if (remoteWatermarks.currentRev < localFetchCursor.rev) {
    writeFetchCursor(db, { rev: 0, path: null }, backend);
    fetchRevReset = true;
  }

  // The remote's fetch cursor rev is the largest senderRev it has
  // applied from us — every push handler advances the fetch cursor to
  // the incoming senderRev, and fetchChanges echoes that cursor back
  // as appliedPushCursor. If its rev is below our local pushRev, the
  // remote has not seen what we claimed to ship; reset our pushRev so
  // the next pushOnce re-baselines from rev 0.
  //
  // We deliberately do NOT compare against remoteWatermarks.pushRev:
  // that field is the remote's own *outbound* push progress and
  // stays at 0 in topologies where the remote never initiates a push
  // (e.g. the container side of a DO↔container backend), which would
  // make every reconcile spuriously reset pushRev and force a full
  // re-push on every reconnect.
  if (remoteWatermarks.fetchCursor.rev < localPushRev) {
    writeWatermark(db, "pushRev", 0, backend);
    pushRevReset = true;
  }

  return { fetchRevReset, pushRevReset };
}
