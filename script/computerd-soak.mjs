#!/usr/bin/env node

// computerd-soak.mjs — soak test for the sync loop between a host and
// one computerd.
//
// Boots one computerd container and plays the part the durable object
// plays in production: this script holds the authoritative store and
// drives sync across the capnweb session. Files are written into the
// host store at a steady rate while a tick loop pushes them to the
// daemon. While that runs, sample:
//
//   - the host store's currentRev — how far the writer has got.
//   - the daemon's currentRev — how far sync has carried it.
//   - docker stats — resident memory for the container.
//
// The gap between the two revision columns is the convergence lag. The
// memory column is the other reason this script exists: it is the
// cheapest way to watch the daemon's footprint under write pressure.
//
// This used to boot a second daemon and point UPSTREAM_URL at the
// first. That measured a daemon driving its own sync loop, which is a
// mode no deployment uses and which no longer exists. A workspace pairs
// one host with one container, so that is what this soaks.
//
// Output is a TSV table on stdout, one row per sample, suitable for
// piping into a CSV reader or just eyeballing.
//
// Knobs (env vars):
//
//   COMPUTERD_BINARY  path to computerd-linux-x64 binary
//   SOAK_DURATION_MS  total wall time of the soak phase (default 30000)
//   SOAK_WRITES_PER_S target writes/second sustained (default 200)
//   SOAK_PAYLOAD_B    bytes per write (default 64)
//   SOAK_SAMPLE_MS    sampling interval (default 250)
//   SOAK_TICK_MS      sync tick interval (default 100)

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
import { pullOnce, pushOnce } from "@cloudflare/computer-rpc/driver";
import { currentRev, Database, initializeSchema, SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import WebSocket from "ws";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const BINARY =
  process.env.COMPUTERD_BINARY ?? resolve(REPO_ROOT, "artifacts/computerd/computerd-linux-x64");
const DURATION_MS = Number(process.env.SOAK_DURATION_MS ?? 30_000);
const WRITES_PER_S = Number(process.env.SOAK_WRITES_PER_S ?? 200);
const PAYLOAD_B = Number(process.env.SOAK_PAYLOAD_B ?? 64);
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MS ?? 250);

// SOAK_DISABLE_FUSE=1 skips the FUSE device/cap plumbing and
// passes FUSE_MOUNT=none into the container. Useful in
// environments where /dev/fuse isn't exposed to the host
// (e.g. running inside a sandbox container, or CI without
// privileged docker). The sync wire still exercises the full
// push/pull loop; only the FUSE mount on the container side is
// skipped.
const DISABLE_FUSE = process.env.SOAK_DISABLE_FUSE === "1" || !existsSync("/dev/fuse");

// Matches MOUNT_POINT in the container env below. The store keeps
// everything under the mount point so pushed paths land where the FUSE
// mount expects them.
const MOUNT_POINT = "/workspace";
const TICK_MS = Number(process.env.SOAK_TICK_MS ?? 100);

const IMAGE_TAG = "computerd-harness:libfuse2";

if (!existsSync(BINARY)) {
  console.error(`computerd binary not found at ${BINARY}`);
  process.exit(1);
}

async function ensureImage() {
  try {
    await execFileP("docker", ["image", "inspect", IMAGE_TAG]);
    return;
  } catch {
    // build it
  }
  process.stderr.write(`building ${IMAGE_TAG}...\n`);
  const proc = spawn("docker", ["build", "--platform", "linux/amd64", "-t", IMAGE_TAG, "-"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  proc.stdin.end(
    `FROM --platform=linux/amd64 debian:stable-slim
RUN apt-get update >/dev/null && apt-get install -y --no-install-recommends \\
      fuse3 libfuse2t64 attr util-linux coreutils findutils \\
      >/dev/null && rm -rf /var/lib/apt/lists/*
`,
  );
  await new Promise((res, rej) => {
    proc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`docker build exit ${code}`))));
  });
}

async function bootContainer() {
  const args = ["run", "--rm", "-d", "--platform", "linux/amd64"];
  if (!DISABLE_FUSE) {
    args.push(
      "--privileged",
      "--device",
      "/dev/fuse",
      "--cap-add",
      "SYS_ADMIN",
      "--cap-add",
      "MKNOD",
      "--security-opt",
      "apparmor=unconfined",
      "--security-opt",
      "seccomp=unconfined",
    );
  }
  args.push(
    "-v",
    `${BINARY}:/usr/local/bin/computerd:ro`,
    "-p",
    "0:8080",
    "-e",
    "PORT=8080",
    "-e",
    `MOUNT_POINT=${MOUNT_POINT}`,
  );
  if (DISABLE_FUSE) {
    args.push("-e", "FUSE_MOUNT=none");
  }
  const image = DISABLE_FUSE ? "debian:stable-slim" : IMAGE_TAG;
  args.push(image, "/usr/local/bin/computerd");
  const { stdout } = await execFileP("docker", args);
  const cid = stdout.trim();
  const { stdout: portOut } = await execFileP("docker", ["port", cid, "8080/tcp"]);
  const port = Number(portOut.split("\n")[0].split(":").pop());
  const url = `http://127.0.0.1:${port}`;
  // Wait for /health
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return { cid, url, port };
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`container ${cid} did not become healthy`);
}

async function kill(cid) {
  try {
    await execFileP("docker", ["kill", cid]);
  } catch {
    /* already dead */
  }
}

// Sample container RSS from `docker stats --no-stream`.
async function dockerStats(cids) {
  const { stdout } = await execFileP("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.ID}} {{.MemUsage}}",
    ...cids.map((c) => c.slice(0, 12)),
  ]);
  const result = {};
  for (const line of stdout.trim().split("\n")) {
    const [id, mem] = line.split(" ", 2);
    // mem looks like "12.5MiB / 7.756GiB"; take the left side.
    const usage = mem.split(" / ")[0];
    result[id] = usage;
  }
  return result;
}

// The daemon's revision numbers over plain HTTP. A sampler wanting
// three integers on an interval does not need an RPC session.
async function fetchWatermarks(url) {
  const res = await fetch(`${url}/api/watermarks`);
  if (!res.ok) throw new Error(`watermarks HTTP ${res.status}`);
  return await res.json();
}

// Build a payload-bytes Uint8Array.
//
// SOAK_PAYLOAD=incompressible (default): pseudo-random byte
// pattern so a deflate-on-the-wire test doesn't get a free
// win from the payload itself.
//
// SOAK_PAYLOAD=text: repeated ASCII so deflate can show its
// compression ratio when it's enabled on the wire.
const PAYLOAD_MODE = process.env.SOAK_PAYLOAD ?? "incompressible";
function payloadBytes(seed) {
  const out = new Uint8Array(PAYLOAD_B);
  if (PAYLOAD_MODE === "text") {
    const filler = `change ${seed} \u2014 the quick brown fox jumps over the lazy dog. `;
    const bytes = new TextEncoder().encode(filler);
    for (let i = 0; i < PAYLOAD_B; i++) out[i] = bytes[i % bytes.length];
  } else {
    for (let i = 0; i < PAYLOAD_B; i++) out[i] = (seed * 31 + i) & 0xff;
  }
  return out;
}

// Persistent capnweb session against the daemon. Reused across the
// soak: one upgrade, many push round-trips.
//
// SOAK_NO_DEFLATE=1 dials without permessage-deflate so the soak can
// compare compressed and uncompressed wire costs without rebuilding
// the computerd binary.
function openSession(url) {
  return createWorkspaceClient({
    url: `${url.replace("http://", "ws://")}/api`,
    WebSocketImpl: class extends WebSocket {
      constructor(target) {
        super(target, { perMessageDeflate: process.env.SOAK_NO_DEFLATE !== "1" });
      }
    },
  });
}

// The authoritative store, standing in for the durable object's SQLite.
function openHostStore() {
  const db = new Database(new SQLiteTestStorage());
  initializeSchema(db, () => Date.now());
  return { db, provider: new SQLiteWorkspaceProvider(db, { now: () => Date.now() }) };
}

// One write into the host store. The sync tick below is what carries
// it to the daemon, so this is a plain filesystem write rather than a
// wire call.
function writeOne(provider, i, bytes) {
  provider.writeFileSync(`${MOUNT_POINT}/soak_${i}.bin`, Buffer.from(bytes));
}

async function main() {
  if (!DISABLE_FUSE) await ensureImage();

  process.stderr.write("booting computerd ...\n");
  const daemon = await bootContainer();
  process.stderr.write(`  ${daemon.url} (${daemon.cid.slice(0, 12)})\n`);

  const { db, provider } = openHostStore();
  provider.mkdirSync(MOUNT_POINT, { recursive: true });
  const session = openSession(daemon.url);

  // Header row. host_rev is how far the writer has got; daemon_rev is
  // how far sync has carried it. The difference is the lag.
  console.log("t_ms\thost_rev\tdaemon_rev\tdaemon_pushRev\tmem\twrites_sent\tpushed");

  const start = Date.now();
  const stopAt = start + DURATION_MS;
  const intervalMs = Math.max(1, Math.floor(1000 / WRITES_PER_S));
  let writeSeq = 0;
  let writesSent = 0;

  // Writes land in the host store. The sync tick below carries them
  // over the wire, which is the direction production runs: the host
  // owns the truth and pushes it to the container.
  const writeLoop = (async () => {
    while (Date.now() < stopAt) {
      const seq = writeSeq++;
      writeOne(provider, seq, payloadBytes(seq));
      writesSent++;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  // Sync tick. pushOnce ships whatever the writer has committed since
  // the last tick; pullOnce brings back anything the daemon changed on
  // its own, which is nothing here but exercises the other direction.
  // A failed tick logs and continues: watermarks are durable, so the
  // next tick resumes where this one stopped.
  let pushed = 0;
  let ticking = false;
  const tickTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    (async () => {
      pushed += await pushOnce(db, session.sync);
      await pullOnce(db, session.sync);
    })()
      .catch((err) => {
        process.stderr.write(`sync tick failed: ${err.message}\n`);
      })
      .finally(() => {
        ticking = false;
      });
  }, TICK_MS);

  // Sample loop. Runs in parallel with the writes and the tick.
  const samples = [];
  const sampleLoop = (async () => {
    while (Date.now() < stopAt + 5000) {
      const t = Date.now() - start;
      const [wm, stats] = await Promise.all([
        fetchWatermarks(daemon.url).catch(() => null),
        dockerStats([daemon.cid]).catch(() => ({})),
      ]);
      const row = [
        t,
        currentRev(db),
        wm?.currentRev ?? -1,
        wm?.pushRev ?? -1,
        stats[daemon.cid.slice(0, 12)] ?? "?",
        writesSent,
        pushed,
      ];
      console.log(row.join("\t"));
      samples.push(row);
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();

  await writeLoop;
  process.stderr.write(`writes done (${writesSent} committed locally)\n`);
  // Let the tick drain what the writer just committed.
  await new Promise((r) => setTimeout(r, 3000));
  await sampleLoop;
  clearInterval(tickTimer);
  await session.close().catch(() => {});
  await kill(daemon.cid);

  // Summary on stderr.
  const final = samples[samples.length - 1] ?? [];
  process.stderr.write(`\n--- soak complete ---\n`);
  process.stderr.write(`writes committed:  ${writeSeq}\n`);
  process.stderr.write(`entries pushed:    ${pushed}\n`);
  process.stderr.write(`final host rev:    ${final[1]}\n`);
  process.stderr.write(`final daemon rev:  ${final[2]} (lag: ${final[1] - final[2]})\n`);
  process.stderr.write(`final mem:         ${final[4]}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
