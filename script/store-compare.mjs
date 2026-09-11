// Compares computerd's two stores: in memory against a file on disk.
//
// It drives the dofs filesystem directly, without a FUSE mount, so any
// difference in the numbers comes from the store and nothing else. The
// operations are the ones most likely to suffer when reads have to
// reach a disk: path resolution, stat, readdir, and small file writes.
//
// Run from the repository root, after a build:
//
//   node script/store-compare.mjs
//
// Environment:
//   FILES=2000          files created per tree
//   CACHE_MIB=64,256    page cache budgets to compare, in mebibytes
//
// For the same comparison through a real FUSE mount, see
// script/fs-bench.sh. For what the file store saves on a restart, see
// script/restore-time.mjs.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";
import { NodeSQLiteStorage } from "@cloudflare/dofs/node";

const FILES = Number(process.env.FILES ?? 2000);
const CACHE_MIB = (process.env.CACHE_MIB ?? "64,256")
  .split(",")
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);

function ms(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function msAsync(fn) {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function open(location, cacheSizeBytes) {
  const storage = new NodeSQLiteStorage(
    cacheSizeBytes === undefined ? { location } : { location, cacheSizeBytes },
  );
  const db = new Database(storage);
  initializeSchema(db, () => 1000);
  return { storage, db, fs: new WorkspaceFilesystem(db, { now: () => 1000 }) };
}

async function buildTree(fs) {
  await fs.mkdir("/w/pkg", { recursive: true });
  for (let i = 0; i < FILES; i++) {
    await fs.writeFile(`/w/pkg/f${i}.js`, `module.exports = ${i};\n`);
  }
}

const paths = Array.from({ length: FILES }, (_, i) => `/w/pkg/f${i}.js`);

// A file store can be reopened to get a genuinely cold cache. An
// in-memory store cannot, so its first pass over a freshly built tree
// is the closest equivalent.
async function measure(label, location, cacheSizeBytes) {
  let handle = open(location, cacheSizeBytes);
  const create = await msAsync(() => buildTree(handle.fs));

  if (location !== ":memory:") {
    handle.storage.close();
    handle = open(location, cacheSizeBytes);
  }

  const statCold = ms(() => {
    for (const p of paths) handle.fs.stat(p);
  });
  const statWarm = ms(() => {
    for (const p of paths) handle.fs.stat(p);
  });
  const readdir = ms(() => {
    for (let i = 0; i < 50; i++) handle.fs.ls("/w/pkg");
  });

  const sizeBytes = handle.storage.sizeBytes();
  handle.storage.close();
  return { label, create, statCold, statWarm, readdir, sizeBytes };
}

const dir = mkdtempSync(join(tmpdir(), "store-compare-"));
const rows = [];
try {
  rows.push(await measure("memory", ":memory:"));
  for (const mib of CACHE_MIB) {
    const path = join(dir, `file-${mib}.db`);
    const row = await measure(`file cache=${mib}MiB`, path, mib * 1024 * 1024);
    row.fileBytes = statSync(path).size;
    rows.push(row);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const base = rows[0];
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n) => v.toFixed(1).padStart(n);

console.log(`\nfiles=${FILES}  node=${process.version}\n`);
console.log(
  `${pad("store", 20)} ${pad("create", 10)} ${pad("stat cold", 12)} ${pad("stat warm", 12)} ${pad("readdir x50", 12)} ${pad("db MiB", 8)}`,
);
console.log("-".repeat(80));
for (const r of rows) {
  const ratio = (v, b) => (r === base ? "" : ` (${(v / b).toFixed(2)}x)`);
  console.log(
    `${pad(r.label, 20)} ${num(r.create, 7)}ms${ratio(r.create, base.create)}  ` +
      `${num(r.statCold, 7)}ms${ratio(r.statCold, base.statCold)}  ` +
      `${num(r.statWarm, 7)}ms${ratio(r.statWarm, base.statWarm)}  ` +
      `${num(r.readdir, 7)}ms${ratio(r.readdir, base.readdir)}  ` +
      `${((r.fileBytes ?? r.sizeBytes) / 1024 / 1024).toFixed(1)}`,
  );
}
console.log(`\n${JSON.stringify({ files: FILES, rows })}\n`);
