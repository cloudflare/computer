// Bidirectional sync driver. Pairs a local Database with a remote
// SyncRPC stub and runs pull + push ticks against the wire.
//
// Both sides of the prototype use the same driver: the container
// (wsd) drives an upstream DO stub, and once the DO has a real
// runtime it'll drive a container stub the same way.
//
// The driver doesn't own a timer. The caller decides when to call
// `pullOnce()` and `pushOnce()` \u2014 a polling loop in production,
// a manual `tick()` in tests so convergence is deterministic.

import {
  type ApplyResult,
  applyChanges,
  assertAppliedPushRev,
  type ChangeEntry,
  coalesceChanges,
  currentRev,
  type Database,
  readWatermark,
  type SkippedEntry,
  stageBlob,
  writeWatermark,
} from "@cloudflare/dofs";

import type { SyncRPC } from "./interface.js";

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

// Pipe `stream` through an identity TransformStream that fires `onDone`
// exactly once when the stream finishes — clean end, cancel, or error.
// Used to release a capnweb result envelope as soon as the stream it
// carried is drained, without having to keep the envelope reference
// alive across the consume site. `onDone` errors are swallowed: the
// stream's content is the load-bearing thing, not the cleanup.
function disposeOnDone<T>(stream: ReadableStream<T>, onDone: () => void): ReadableStream<T> {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    try {
      onDone();
    } catch {
      // ignore — disposer errors are not actionable here
    }
  };
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
      flush() {
        fire();
      },
      cancel() {
        fire();
      },
    }),
  );
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
// pull, apply locally, advance fetchRev. Returns an `ApplyResult`
// folded across every batch so callers see both the applied count
// (decide whether to tick again) and any entries skipped because
// they targeted a read-only mount root (surface to the user).
//
// Bytes the receiver already holds (vfs_blobs.hash present) are
// skipped on the wire; the hasObjects probe is what makes that
// dedup work without per-chunk round-trips.
//
// The entry stream is drained in batches of PULL_BATCH_SIZE so peak
// memory stays bounded on a large tree. fetchRev still advances
// once at the end of the whole stream — per-batch advance would
// require the wire to carry a rev cursor per entry. Crash safety is
// idempotent re-apply: the receiver's alreadyApplied() check inside
// applyChanges drops a re-fetched batch on the floor.
export async function pullOnce(
  db: Database,
  remote: SyncRPC,
  backend?: string,
): Promise<ApplyResult> {
  // Delegate to the inner implementation with retried=false. See
  // pullOnceImpl for the fetchChanges round trip, invariant check,
  // reset-and-retry path, and batched apply loop.
  const sinceRev = readWatermark(db, "fetchRev", backend);
  const localPushRev = readWatermark(db, "pushRev", backend);
  return pullOnceImpl(db, remote, backend, sinceRev, localPushRev, false);
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
  sinceRev: number,
  localPushRev: number,
  retried: boolean,
): Promise<ApplyResult> {
  // fetchChanges hands back the remote's currentRev (cursor we
  // advance fetchRev to), its appliedPushRev (cross-side invariant
  // check on the pull path), and the entry stream itself. One
  // round-trip instead of the previous currentRev() + fetchChanges()
  // pair.
  // The fetchChanges return is a capnweb result envelope wrapping a
  // stream stub; without explicit disposal it sits in the exports
  // table until the session ends. We can't bind it to `using`
  // because the stream inside outlives this scope (we hand it off
  // to the reader loop below), so wrap the stream in a transform
  // that disposes the envelope when the stream finishes draining.
  const fetchResult = await remote.fetchChanges({ sinceRev });
  const { currentRev: remoteRev, appliedPushRev } = fetchResult;
  // Cross-side watermark divergence. Two shapes are recoverable:
  //   * appliedPushRev < localPushRev: the remote forgot what we
  //     pushed (typically a process-lifetime wsd restart while the
  //     WebSocket survived, so reconcileWatermarks on connect never
  //     re-ran).
  //   * remoteRev < sinceRev: the remote's log is shorter than we
  //     remember — same root cause, different symptom.
  // Both are the inline equivalent of reconcileWatermarks: reset
  // the divergent cursor to 0, cancel the in-flight stream, and
  // retry once. The rev-0 baseline path in fetchChanges + pushOnce
  // re-ships everything incrementally and the receiver's
  // alreadyApplied() check absorbs the redundant work.
  //
  // A second divergence after a reset is a real protocol break:
  // surface it via the assertion below rather than loop.
  if (!retried && (appliedPushRev < localPushRev || remoteRev < sinceRev)) {
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
    maybeDispose(fetchResult);
    // Surface the divergence at debug level so an operator with
    // log access can spot a persistently broken remote. We do not
    // throw: a one-shot divergence is normal after a wsd restart
    // under the same WebSocket, and the inline reset + retry is
    // the intended recovery. A persistently-lying remote will log
    // this on every pull, which is the operational signal that
    // something upstream is wedged.
    console.debug("[pullOnce] cross-side watermark divergence; resetting and retrying", {
      backend,
      appliedPushRev,
      localPushRev,
      remoteRev,
      sinceRev,
      resetPushRev: appliedPushRev < localPushRev,
      resetFetchRev: remoteRev < sinceRev,
    });
    if (appliedPushRev < localPushRev) {
      writeWatermark(db, "pushRev", 0, backend);
    }
    if (remoteRev < sinceRev) {
      writeWatermark(db, "fetchRev", 0, backend);
    }
    const nextSinceRev = readWatermark(db, "fetchRev", backend);
    const nextLocalPushRev = readWatermark(db, "pushRev", backend);
    return pullOnceImpl(db, remote, backend, nextSinceRev, nextLocalPushRev, true);
  }
  // After the retry path above, this assertion guards a
  // divergence that survived a reset. Tear down rather than loop.
  assertAppliedPushRev(appliedPushRev, localPushRev);
  const stream = disposeOnDone(fetchResult.stream, () => maybeDispose(fetchResult));
  if (remoteRev <= sinceRev) {
    // Drain the (empty) stream so the remote's iterator is
    // released; cancel is the right surface for that.
    await stream.cancel().catch(() => {});
    return { applied: 0, skipped: [] };
  }

  const reader = stream.getReader();
  let totalApplied = 0;
  const totalSkipped: SkippedEntry[] = [];
  let streamDone = false;
  try {
    while (!streamDone) {
      // Read up to PULL_BATCH_SIZE entries before processing the batch.
      const batch: ChangeEntry[] = [];
      const wantedHashes: Uint8Array[] = [];
      const seenHash = new Set<string>();
      let batchMaxRev = 0;
      while (batch.length < PULL_BATCH_SIZE) {
        const { value, done } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }
        batch.push(value);
        if (value.rev > batchMaxRev) batchMaxRev = value.rev;
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
      if (wantedHashes.length > 0) {
        const haveSubset = await remote.hasObjects(wantedHashes);
        const remoteHasLocally = new Set<string>();
        for (const h of haveSubset) remoteHasLocally.add(hex(h));
        const missing = wantedHashes.filter((h) => {
          const k = hex(h);
          if (!remoteHasLocally.has(k)) return false;
          const row = db.one<{ hash: Uint8Array }>("SELECT hash FROM vfs_blobs WHERE hash = ?", h);
          return row === undefined;
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

      // Advance fetchRev per committed batch. Because coalesceChanges
      // emits in ascending rev order, every entry already applied
      // (this batch + all previous ones) has rev <= batchMaxRev, so
      // it's safe to checkpoint here. A crash after this commit
      // means the next pull resumes from batchMaxRev and re-fetches
      // only entries from later batches — bounded by PULL_BATCH_SIZE
      // instead of the whole stream.
      const batchResult = await applyChanges(db, batch, new Map(), {
        source: "upstream",
        advanceFetchRev: batchMaxRev,
        backend,
      });
      totalApplied += batchResult.applied;
      if (batchResult.skipped.length > 0) {
        for (const s of batchResult.skipped) totalSkipped.push(s);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Nudge fetchRev to the remote's currentRev captured at the start.
  // The per-batch advances above bring fetchRev up to the max rev
  // any entry carried, but if the rev window contained entries that
  // were all filtered out (e.g. ignored paths), the stream is empty
  // and the per-batch path never fires. Advancing to remoteRev here
  // is still safe because we captured it before draining the stream
  // and never regress.
  const current = readWatermark(db, "fetchRev", backend);
  if (remoteRev > current) {
    writeWatermark(db, "fetchRev", remoteRev, backend);
  }
  return { applied: totalApplied, skipped: totalSkipped };
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
  for await (const e of coalesceChanges(db, sincePush)) {
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

  // Cross-side invariant: the receiver must echo back at least
  // the rev we just claimed to push. A drift means the apply
  // path lost data, or a stale receiver is serving an old
  // snapshot. Tear down loudly rather than corrupt watermarks.
  assertAppliedPushRev(response.appliedPushRev, localRev);

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
// in durable storage and survive its incarnations, but today's wsd
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
  const localFetchRev = readWatermark(db, "fetchRev", backend);
  const localPushRev = readWatermark(db, "pushRev", backend);

  let fetchRevReset = false;
  let pushRevReset = false;

  // If the remote's currentRev is below our fetchRev, the remote's
  // log is shorter than we remember — it lost state since we last
  // pulled. Re-baseline from 0.
  if (remoteWatermarks.currentRev < localFetchRev) {
    writeWatermark(db, "fetchRev", 0, backend);
    fetchRevReset = true;
  }

  // The remote's fetchRev is the largest senderRev it has applied
  // from us — every push handler advances fetchRev to the incoming
  // senderRev, and fetchChanges echoes that value back as
  // appliedPushRev. If it's below our local pushRev, the remote has
  // not seen what we claimed to ship; reset our pushRev so the next
  // pushOnce re-baselines from rev 0.
  //
  // We deliberately do NOT compare against remoteWatermarks.pushRev:
  // that field is the remote's own *outbound* push progress and
  // stays at 0 in topologies where the remote never initiates a push
  // (e.g. the container side of a DO↔container backend), which would
  // make every reconcile spuriously reset pushRev and force a full
  // re-push on every reconnect.
  if (remoteWatermarks.fetchRev < localPushRev) {
    writeWatermark(db, "pushRev", 0, backend);
    pushRevReset = true;
  }

  return { fetchRevReset, pushRevReset };
}
