// Block planning: turn a cursor window into one transferable unit.
//
// A block is an ordered prefix of the coalesced change stream, bounded
// by the internal sizing profile. Determinism is the property the
// whole restart story rests on: the same `after` and `through` with the
// same profile must select the same entries, because an unacknowledged
// block is re-requested and the receiver has to absorb the replay as a
// no-op rather than as new work.
//
// Block sizing is never caller-visible. The public `pull()` and
// `push()` iterables take no budgets; these bounds exist so one block
// fits inside a Durable Object's CPU allowance.

import type { Database } from "../storage.js";
import type { ChangeEntry } from "./changes.js";
import { coalesceChanges } from "./coalesce.js";
import type { BlockProfile, SyncMode } from "./operations.js";
import type { ChangeCursor } from "./watermarks.js";

// Above either threshold an operation switches from shipping
// individual entries to shipping a compressed content-addressed pack.
// The measured package-install benchmark crossed both by a wide
// margin: 44,264 entries and an estimated 914 MB window.
export const PACK_THRESHOLD_ENTRIES = 20_000;
export const PACK_THRESHOLD_BYTES = 100 * 1024 * 1024;

export interface BlockObject {
  readonly hash: Uint8Array;
  readonly size: number;
}

export interface PlannedBlock {
  // Entries in wire order. Already coalesced, so one path appears at
  // most once.
  readonly entries: ChangeEntry[];
  // Unique objects referenced by this block's entries. Deduplicated
  // within the block only; duplicates across blocks are absorbed by
  // the receiver's content-addressed store, which is cheaper than
  // carrying operation-wide sent-object state.
  readonly objects: BlockObject[];
  readonly objectBytes: number;
  // Cursor to persist once this block is applied and acknowledged.
  // The target when the window drained, otherwise the last fully
  // selected entry — never a partially selected one.
  readonly cursor: ChangeCursor;
  // True when this block reached the fixed target, meaning the
  // operation is complete once this block commits.
  readonly drained: boolean;
}

export interface PlanBlockRequest {
  readonly after: ChangeCursor;
  readonly through: ChangeCursor;
  readonly profile: BlockProfile;
  readonly ignore?: string[];
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Objects referenced by one entry. Only file entries carry bytes;
// directories, symlinks, and tombstones are metadata only, which is
// why a delete-heavy window stays cheap regardless of entry count.
function objectsOf(entry: ChangeEntry): BlockObject[] {
  return entry.kind === "file" ? entry.chunks.map((c) => ({ hash: c.hash, size: c.size })) : [];
}

// Select an ordered prefix of the window.
//
// The entry limit and the unique-object byte limit both stop
// selection, with one exception: an entry selected into an empty block
// is always kept even if it alone exceeds the byte budget. Without
// that rule a file larger than the budget would be selected, rejected
// for being oversized, and retried at the same cursor forever.
export async function planBlock(db: Database, request: PlanBlockRequest): Promise<PlannedBlock> {
  const { after, through, profile } = request;
  const entries: ChangeEntry[] = [];
  const objects: BlockObject[] = [];
  const seen = new Set<string>();
  let objectBytes = 0;
  let drained = true;

  const options = request.ignore === undefined ? { through } : { through, ignore: request.ignore };

  for await (const entry of coalesceChanges(db, after, options)) {
    if (entries.length >= profile.maxEntries) {
      // The window still has entries the profile cannot carry, so the
      // operation is not finished at this cursor.
      drained = false;
      break;
    }

    // Cost this entry against objects the block does not already
    // carry. Two paths sharing content cost bytes once.
    const candidates = objectsOf(entry).filter((o) => !seen.has(toHex(o.hash)));
    const unique = new Map<string, BlockObject>();
    for (const object of candidates) unique.set(toHex(object.hash), object);
    let addedBytes = 0;
    for (const object of unique.values()) addedBytes += object.size;

    if (entries.length > 0 && objectBytes + addedBytes > profile.maxBytes) {
      drained = false;
      break;
    }

    entries.push(entry);
    for (const [key, object] of unique) {
      seen.add(key);
      objects.push(object);
      objectBytes += object.size;
    }
  }

  // A drained window means every change through the target was
  // offered, so the cursor jumps to the target itself. That is what
  // lets an operation complete on a cursor whose rev carries no
  // entries of its own.
  const last = entries[entries.length - 1];
  const cursor: ChangeCursor = drained
    ? through
    : last === undefined
      ? after
      : { rev: last.rev, path: last.path };

  return { entries, objects, objectBytes, cursor, drained };
}

export interface SelectModeRequest extends PlanBlockRequest {
  // Overridable so tests can cross a threshold without materialising
  // 20,000 files. Production callers use the module constants.
  readonly thresholdEntries?: number;
  readonly thresholdBytes?: number;
}

export interface ModeDecision {
  readonly mode: SyncMode;
  // The planning pass that answered the mode question is also the
  // first block, so a large operation does not scan its window twice
  // before transferring anything. See Q3 in
  // docs/decisions/sync-operations.md.
  readonly firstBlock: PlannedBlock;
}

// Decide entry versus pack mode for a whole operation, and return the
// first block from the same pass.
//
// The probe reads up to `max(profile.maxEntries, thresholdEntries)`
// entries. Filling the probe is itself the signal that the window is
// at or past the entry threshold, so the question is answered without
// draining a window that may hold 44,000 entries. Only metadata is
// buffered; object payloads are never held here.
//
// The mode is fixed for the operation's life. A block's encoding must
// not depend on when it was requested or a replayed block would not
// match the original, so a wrong estimate is not corrected mid-flight.
// The target is fixed at creation, so the window cannot grow under the
// estimate.
export async function selectMode(db: Database, request: SelectModeRequest): Promise<ModeDecision> {
  const thresholdEntries = request.thresholdEntries ?? PACK_THRESHOLD_ENTRIES;
  const thresholdBytes = request.thresholdBytes ?? PACK_THRESHOLD_BYTES;

  // Probe wide enough to answer the threshold question, but never
  // narrower than one block, so the probe's prefix is reusable as the
  // first block.
  const probeEntries = Math.max(request.profile.maxEntries, thresholdEntries);
  const probe = await planBlock(db, {
    ...request,
    profile: { maxEntries: probeEntries, maxBytes: Number.MAX_SAFE_INTEGER },
  });

  const crossed = probe.entries.length >= thresholdEntries || probe.objectBytes >= thresholdBytes;

  // Re-derive the first block under the real profile. When the probe
  // already fits the profile it *is* the first block and no second
  // pass happens.
  const fits =
    probe.entries.length <= request.profile.maxEntries &&
    probe.objectBytes <= request.profile.maxBytes;
  const firstBlock = fits ? probe : await planBlock(db, request);

  return { mode: crossed ? "pack" : "entries", firstBlock };
}
