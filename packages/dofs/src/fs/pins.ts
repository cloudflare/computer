// In-memory pins on chunk blobs.
//
// A blob with no vfs_chunks row pointing at it looks unused, but some
// code holds its hash across an await and reads or links it later: a
// lazy readFile stream, a streaming writeFile between staging and
// linking, a push sender between hasObjects and pushObjects, and a
// peer told by hasObjects that it need not send a blob. A pin marks
// such a hash as in use, so the code that reclaims unreferenced blobs
// leaves it alone.
//
// Pins live in memory, per Database, like the write buffer and blob
// caches. They are only meaningful when every caller shares one
// Database handle per store, which is how the Workspace Durable Object
// and computerd use it. A restart drops every pin; the incremental
// sweep's grace window covers what was in flight.
//
// No timer drives expiry. A lease is a deadline that is checked when
// someone asks, so a stream dropped without being cancelled stops
// pinning once its lease runs out, without anything having to run.

import type { Database } from "../storage";
import { hashKey } from "./blobCache";

// How long a lazy readFile stream keeps its chunks pinned with nobody
// pulling from it.
export const STREAM_IDLE_LEASE_MS = 5 * 60 * 1000;

// How long a hash hasObjects reported present stays pinned, so the
// peer that skipped sending it can still link it.
export const HAS_OBJECTS_PIN_MS = 10 * 60 * 1000;

// Expired leases are dropped from the registry at most this often, so
// leases nobody asks about again do not pile up in a long-lived
// process.
const PRUNE_INTERVAL_MS = 1000;

export interface Pin {
  // Pin one more hash under this pin.
  add(hash: Uint8Array): void;
  // Push a leased pin's deadline out by its lease. Pins taken without a
  // lease ignore this.
  renew(): void;
  // Drop every hash this pin holds. Idempotent.
  release(): void;
}

interface Lease {
  readonly keys: Set<string>;
  readonly leaseMs: number | undefined;
  expiresAt: number;
  released: boolean;
}

interface Registry {
  byHash: Map<string, Set<Lease>>;
  // Leased pins only, so they can be pruned once they expire.
  leased: Set<Lease>;
  lastPrune: number;
}

const registries = new WeakMap<Database, Registry>();

function registryFor(db: Database): Registry {
  let registry = registries.get(db);
  if (registry === undefined) {
    registry = { byHash: new Map(), leased: new Set(), lastPrune: 0 };
    registries.set(db, registry);
  }
  return registry;
}

function expired(lease: Lease, now: number): boolean {
  return lease.expiresAt <= now;
}

function register(registry: Registry, lease: Lease, key: string): void {
  let holders = registry.byHash.get(key);
  if (holders === undefined) {
    holders = new Set();
    registry.byHash.set(key, holders);
  }
  holders.add(lease);
}

function unregister(registry: Registry, lease: Lease): void {
  for (const key of lease.keys) {
    const holders = registry.byHash.get(key);
    if (holders === undefined) continue;
    holders.delete(lease);
    if (holders.size === 0) registry.byHash.delete(key);
  }
  registry.leased.delete(lease);
}

function prune(registry: Registry, now: number): void {
  if (now - registry.lastPrune < PRUNE_INTERVAL_MS) return;
  registry.lastPrune = now;
  for (const lease of registry.leased) {
    if (expired(lease, now)) unregister(registry, lease);
  }
}

// Pin `hashes` until release(). With `leaseMs`, the pin also lapses
// once that long passes without a renew().
export function pinHashes(
  db: Database,
  hashes: Iterable<Uint8Array>,
  options: { leaseMs?: number } = {},
): Pin {
  const registry = registryFor(db);
  const now = Date.now();
  prune(registry, now);
  const lease: Lease = {
    keys: new Set(),
    leaseMs: options.leaseMs,
    expiresAt: options.leaseMs === undefined ? Number.POSITIVE_INFINITY : now + options.leaseMs,
    released: false,
  };
  if (lease.leaseMs !== undefined) registry.leased.add(lease);

  const add = (hash: Uint8Array): void => {
    if (lease.released) return;
    const key = hashKey(hash);
    lease.keys.add(key);
    register(registry, lease, key);
  };
  for (const hash of hashes) add(hash);

  return {
    add,
    renew() {
      if (lease.released || lease.leaseMs === undefined) return;
      const at = Date.now();
      if (expired(lease, at)) {
        // A lapsed lease may have been pruned. Put it back.
        registry.leased.add(lease);
        for (const key of lease.keys) register(registry, lease, key);
      }
      lease.expiresAt = at + lease.leaseMs;
    },
    release() {
      if (lease.released) return;
      lease.released = true;
      unregister(registry, lease);
    },
  };
}

// Pin chunk blobs a sync sender is about to read while a peer pulls
// them, so a local write cannot reclaim them halfway through. Release
// the pin once the transfer is over.
export function pinObjects(db: Database, hashes: Iterable<Uint8Array>): { release(): void } {
  const pin = pinHashes(db, hashes);
  return { release: () => pin.release() };
}

export function isPinned(db: Database, hash: Uint8Array): boolean {
  return isKeyPinned(db, hashKey(hash));
}

// Same as isPinned, for callers that already hold the hash's key.
export function isKeyPinned(db: Database, key: string): boolean {
  const registry = registries.get(db);
  const holders = registry?.byHash.get(key);
  if (registry === undefined || holders === undefined) return false;
  const now = Date.now();
  for (const lease of holders) {
    if (!expired(lease, now)) return true;
    unregister(registry, lease);
  }
  return false;
}
