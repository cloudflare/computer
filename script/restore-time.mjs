// Measures what an on-disk store saves when computerd restarts.
//
// Two runs, same workload:
//   memory  - the store is rebuilt empty, so the peer re-ships the tree.
//   file    - the store is reopened, so the peer ships only the delta.
//
// "Restore" here is the wall time from a started daemon to a workspace
// the peer agrees is up to date: connect, reconcile watermarks, and
// push whatever the peer thinks is missing. That is the cost a real
// host pays before the first command can run.
//
// Usage, from the repository root:
//   node script/restore-time.mjs [fileCount]

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILES = Number(process.argv[2] ?? 2000);
const CLI = new URL("../packages/computerd/dist/cli/computerd.cjs", import.meta.url).pathname;

const { Database, initializeSchema, WorkspaceFilesystem } = await import("@cloudflare/dofs");
const { SQLiteTestStorage } = await import("@cloudflare/dofs/testing");
const { createWorkspaceClient } = await import("@cloudflare/computer-rpc/client");
const { pushOnce, reconcileWatermarks } = await import("@cloudflare/computer-rpc/driver");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("daemon never became healthy");
}

function start(port, mountPoint, storePath) {
  const child = spawn("node", [CLI], {
    env: {
      ...process.env,
      PORT: String(port),
      MOUNT_POINT: mountPoint,
      FUSE_MOUNT: "none",
      COMPUTERD_DB: storePath ?? "memory",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8000);
  });
}

// The durable-object side: an authoritative store holding the tree.
function buildPeer() {
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, Date.now);
  return db;
}

async function seedPeer(db) {
  const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
  await fs.mkdir("/w/pkg", { recursive: true });
  for (let i = 0; i < FILES; i++) {
    await fs.writeFile(`/w/pkg/f${i}.js`, `module.exports = ${i};\n`);
  }
}

// One measured cycle. Returns the milliseconds from "daemon is
// healthy" to "peer has finished syncing it".
async function cycle({ storePath, mountPoint, peer }) {
  const port = await freePort();
  const child = start(port, mountPoint, storePath);
  await waitHealthy(port);

  const started = process.hrtime.bigint();
  const client = createWorkspaceClient({ url: `ws://127.0.0.1:${port}/api` });
  let pushed = 0;
  try {
    await reconcileWatermarks(peer, client.sync);
    pushed = await pushOnce(peer, client.sync);
  } finally {
    await client.close();
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  await stop(child);
  return { ms, pushed };
}

const dir = mkdtempSync(join(tmpdir(), "restore-time-"));
const rows = [];
try {
  for (const mode of ["memory", "file"]) {
    const mountPoint = join(dir, `mount-${mode}`);
    const storePath = mode === "file" ? join(dir, `${mode}.db`) : undefined;

    // A fresh peer per mode so both start from the same place.
    const peer = buildPeer();
    await seedPeer(peer);

    // First boot: the daemon is empty either way, so this is the
    // cold cost of shipping the whole tree.
    const first = await cycle({ storePath, mountPoint, peer });

    // Second boot: this is the restore. With a file store the daemon
    // reopens what it had; with memory it starts empty again.
    const second = await cycle({ storePath, mountPoint, peer });

    rows.push({ mode, first, second });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nfiles=${FILES}\n`);
console.log(`${"store".padEnd(8)} ${"first boot".padStart(22)} ${"restart".padStart(22)}`);
console.log("-".repeat(56));
for (const r of rows) {
  const f = `${r.first.ms.toFixed(0)}ms (${r.first.pushed} pushed)`;
  const s = `${r.second.ms.toFixed(0)}ms (${r.second.pushed} pushed)`;
  console.log(`${r.mode.padEnd(8)} ${f.padStart(22)} ${s.padStart(22)}`);
}
const mem = rows.find((r) => r.mode === "memory");
const file = rows.find((r) => r.mode === "file");
if (mem && file) {
  console.log(
    `\nrestart saving: ${(mem.second.ms - file.second.ms).toFixed(0)}ms ` +
      `(${(mem.second.ms / Math.max(file.second.ms, 0.01)).toFixed(1)}x faster), ` +
      `${mem.second.pushed - file.second.pushed} fewer entries pushed\n`,
  );
}
console.log(`${JSON.stringify({ files: FILES, rows })}\n`);
