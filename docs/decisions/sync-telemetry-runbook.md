created: 2026-08-25
last updated: 2026-08-25

# Runbook: measuring sync in production

The block benchmarks answer what sync costs in a dev container against
an in-process peer. Three questions they cannot answer are the ones that
decide whether the shipped defaults are right:

1. Does any real block come close to the Durable Object CPU limit?
2. What throughput does the real DO-to-container hop achieve? That is
   the input the entries-versus-pack crossover depends on.
3. Do real operations converge, or do they stall and re-run blocks?

This runbook turns a real session into those answers.

## Enabling

Sync telemetry is off by default. Workers Logs is billed per event and a
44,000-entry sync emits one record per block, so the library does not
write to a consumer's log stream uninvited.

```ts
const workspace = new Workspace({
  storage: ctx.storage,
  backends: [containerBackend],
  syncTelemetryEnabled: true,
});
```

Workers Logs must also be on for the Worker, or nothing is stored:

```jsonc
{
  "observability": {
    "enabled": true,
    "logs": { "invocation_logs": true, "head_sampling_rate": 1 }
  }
}
```

`head_sampling_rate: 1` matters for a measurement run. Sampling would
drop exactly the rare slow blocks worth finding.

## What gets emitted

Two record shapes, both single-line JSON so Workers Logs parses them
into queryable `$workers.event.*` fields.

`sync.block`, one per committed block:

| Field | Why it is there |
|---|---|
| `blockMs` | Wall time for the block. Tracks CPU closely for sync work. |
| `headroom` | `cpuLimitMs / blockMs`. `min()` over a run answers question 1 directly. |
| `overBudget` | True when the block exceeded its allowance. Should never be true. |
| `entries`, `bytes`, `skipped` | Block size, and refusals. |
| `msPerEntry` | Per-entry cost, so blocks of different sizes compare. |
| `bytesPerSecond` | Per-block transport rate. |
| `mode` | `entries` or `pack`, for grouping. |
| `cursorRev`, `targetRev`, `revsBehind` | Convergence lag. |
| `operationId`, `generation` | Regroup blocks that came from separate iterables. |
| `complete` | Last block of an operation. |

`sync.operation`, one per completed operation: `blocks`, `entries`,
`bytes`, `totalMs`, `worstBlockMs`, `bytesPerSecond`,
`entriesPerSecond`, `msPerEntry`, `msPerBlock`, `restarts`.

Derived fields are precomputed because the query API aggregates one
numeric field per calculation; a ratio spanning two fields is not
expressible in a single query.

## The queries

All run through the `cloudflare_telemetry` tool. Set `timeframe` to the
session window in Unix milliseconds.

### 1. Is block sizing safe?

```json
{
  "queryId": "sync-headroom",
  "timeframe": { "from": 0, "to": 0 },
  "parameters": {
    "filters": [
      { "key": "$workers.event.event", "operation": "eq", "value": "sync.block", "type": "string" }
    ],
    "calculations": [
      { "operator": "min", "key": "$workers.event.headroom", "keyType": "number" },
      { "operator": "max", "key": "$workers.event.blockMs", "keyType": "number" },
      { "operator": "p95", "key": "$workers.event.blockMs", "keyType": "number" }
    ],
    "groupBys": [{ "type": "string", "value": "$workers.event.mode" }]
  }
}
```

`min(headroom)` is the headline. The dev-container measurement that
drove `maxEntries` down to 2,000 showed 8.1x; anything approaching 2x in
production means the default is still too large. Compare
`max(blockMs)` against the 30,000 ms allowance.

### 2. Did any block blow the budget?

```json
{
  "parameters": {
    "filters": [
      { "key": "$workers.event.event", "operation": "eq", "value": "sync.block", "type": "string" },
      { "key": "$workers.event.overBudget", "operation": "eq", "value": true, "type": "boolean" }
    ],
    "calculations": [{ "operator": "count" }]
  }
}
```

Expected result is zero. A non-zero count is the failure the whole
restartable design exists to prevent, because a block that cannot finish
never finishes.

### 3. What is the real transport throughput?

```json
{
  "parameters": {
    "filters": [
      { "key": "$workers.event.event", "operation": "eq", "value": "sync.operation", "type": "string" }
    ],
    "calculations": [
      { "operator": "p50", "key": "$workers.event.bytesPerSecond", "keyType": "number" },
      { "operator": "p95", "key": "$workers.event.bytesPerSecond", "keyType": "number" }
    ],
    "groupBys": [{ "type": "string", "value": "$workers.event.mode" }]
  }
}
```

This closes the open question behind the pack thresholds. Multiply
`bytesPerSecond` by 8 for bits: the benchmarks put the
entries-versus-pack crossover near 150 Mbps on small trees and near
500 Mbps at install scale. Below the crossover packs win, above it they
lose and the thresholds should be raised.

### 4. Are operations converging?

```json
{
  "parameters": {
    "filters": [
      { "key": "$workers.event.event", "operation": "eq", "value": "sync.block", "type": "string" }
    ],
    "calculations": [{ "operator": "max", "key": "$workers.event.revsBehind", "keyType": "number" }],
    "groupBys": [{ "type": "string", "value": "$workers.event.operationId" }]
  }
}
```

`revsBehind` should trend to zero within an operation. An operation
whose maximum stays high across many blocks is stalling.

### 5. Cross-check against runtime CPU

The records above are self-reported. The runtime's own accounting is
independent:

```json
{
  "parameters": {
    "filters": [
      { "key": "$workers.executionModel", "operation": "eq", "value": "durableObject", "type": "string" }
    ],
    "calculations": [
      { "operator": "max", "key": "$workers.cpuTimeMs", "keyType": "number" },
      { "operator": "p95", "key": "$workers.cpuTimeMs", "keyType": "number" }
    ],
    "groupBys": [{ "type": "string", "value": "$workers.entrypoint" }]
  }
}
```

`$workers.cpuTimeMs` is true CPU, while `blockMs` is wall time including
I/O wait. If `blockMs` greatly exceeds `cpuTimeMs`, blocks are transport
bound and larger blocks are safe; if they track each other, blocks are
CPU bound and the sizing limit is real.

## Durable state cross-check

`cloudflare_db` reads a SessionDO's SQLite directly, which is how to
confirm that what telemetry claims matches what durably committed:

```sql
-- In-flight operations: status, fixed target, and sizing profile.
SELECT backend, direction, status, target_rev, mode,
       internal_max_entries, internal_max_bytes, last_error
  FROM _vfs_sync_operations;

-- Committed progress. Compare target_rev above against this.
SELECT k, backend, v FROM _vfs_watermark WHERE k IN ('fetchRev', 'pushRev');

-- Entries the receiver refused, which the cursor advanced past.
SELECT backend, direction, path, reason, at FROM _vfs_sync_skips LIMIT 50;
```

A `pending` row whose `target_rev` sits far above the matching watermark
is an operation that is not making progress. A shrunk
`internal_max_entries` means blocks were detected as interrupted, which
is the signal that the default profile is too large for that workload.

## First real-world reading

Run against a live agent session's Durable Object, before any of this
work is deployed:

```sql
SELECT (SELECT v FROM vfs_meta WHERE k='schema_version') AS schema_version,
       (SELECT v FROM vfs_meta WHERE k='rev')            AS current_rev,
       (SELECT COUNT(*) FROM vfs_nodes WHERE type='file') AS files,
       (SELECT SUM(size) FROM vfs_blobs)                  AS blob_bytes;
```

| Measure | Value |
|---|---|
| dofs schema version | 6 |
| Files | 1,296 |
| Blob bytes | 93.9 MB |
| Distinct chunks / chunk rows | 1,326 / 1,344 |
| Local `currentRev` | 2,496 |
| `pushRev` (container) | 2,490 |
| `fetchRev` (container) | 46,539 |

Four things worth noting.

**The schema is v6, so the operation tables are not deployed yet.** The
v6 → v7 migration is additive and backfills nothing, and this confirms
the upgrade path is the one that matters: a live workspace with real
watermarks, not a fresh install.

**A real workspace is 93.9 MB, which is 6% under the 100 MiB pack
threshold.** That is uncomfortably close to a mode boundary. It means
ordinary sessions will sit right at the entries/pack switch, so the
crossover measured in query 3 is not a theoretical concern for large
installs — it decides behavior for a typical workspace. It is also an
argument for revisiting the byte threshold once query 3 has an answer,
since a workspace oscillating across the boundary would alternate
transports between operations.

**Chunk deduplication is doing almost nothing here:** 1,326 distinct
chunks against 1,344 rows, about 1.4%. The benchmark trees assumed one
file in four or eight was a shared payload, which flattered the pack's
object-dedup story. Pack compression still applies to entry metadata,
which is where the install-scale win came from, but object dedup should
not be counted on for this kind of workspace.

**`fetchRev` is 46,539 against a local `currentRev` of 2,496.** The two
counters are independent — one is the container's revision space, the
other the host's — and the ratio shows the container side is roughly
twenty times more write-active. Post-command pull is therefore the
dominant direction, which matches the plan's decision to land pull
first, and means the pull path is where the telemetry above matters
most.
