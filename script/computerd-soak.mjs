#!/usr/bin/env node

// computerd-soak.mjs — soak test for the computerd sync loop.
//
// Boots two computerd containers wired as peer-to-peer:
//   A: standalone computerd, port mapped to the host.
//   B: standalone computerd, port mapped to the host AND
//      UPSTREAM_URL pointing at A's host port. B's sync
//      loop pulls from A and pushes to A.
//
// Hammers A by writing files through its /api endpoint
// (capnweb HTTP batch). While the writes flow, sample:
//
//   - A.watermarks() — currentRev, pushRev, fetchRev.
//   - B.watermarks() — same.
//   - docker stats — RSS for both containers.
//
// Output is a TSV table on stdout, one row per sample,
// suitable for piping into a CSV reader or just eyeballing.
//
// Knobs (env vars):
//
//   COMPUTERD_BINARY        path to computerd-linux-x64 binary
//   SOAK_DURATION_MS  total wall time of the soak phase (default 30000)
//   SOAK_WRITES_PER_S target writes/second sustained against A (default 200)
//   SOAK_PAYLOAD_B    bytes per write (default 64)
//   SOAK_SAMPLE_MS    sampling interval (default 250)

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newHttpBatchRpcSession, newWebSocketRpcSession } from "capnweb";
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

// On Linux, host.docker.internal isn't resolved automatically;
// we map it to the host-gateway address so B can reach A.
// docker-desktop on macOS/Windows already provides this.
const ADD_HOST_GATEWAY = process.platform === "linux";

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

async function bootContainer(extraEnv = {}) {
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
  if (ADD_HOST_GATEWAY) {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }
  args.push(
    "-v",
    `${BINARY}:/usr/local/bin/computerd:ro`,
    "-p",
    "0:8080",
    "-e",
    "PORT=8080",
    "-e",
    "MOUNT_POINT=/workspace",
  );
  if (DISABLE_FUSE) {
    args.push("-e", "FUSE_MOUNT=none");
  }
  for (const [k, v] of Object.entries(extraEnv)) {
    args.push("-e", `${k}=${v}`);
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

// Connect a capnweb HTTP batch client to /api. Each call is
// its own session; we accept the cost (one round-trip per
// hammer-write) so the soak measures the entire stack
// including session setup.
function batchStub(url) {
  return newHttpBatchRpcSession(`${url}/api`);
}

async function fetchWatermarks(url) {
  return await batchStub(url).sync.watermarks();
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

// Persistent capnweb WebSocket session against B. Reused
// across the soak; one upgrade, many push round-trips.
//
// SOAK_NO_DEFLATE=1 forces the dial to negotiate without
// permessage-deflate so the soak can compare compressed and
// uncompressed wire costs without rebuilding the computerd binary.
function wsStub(url) {
  const wsUrl = `${url.replace("http://", "ws://")}/ws`;
  const ws = new WebSocket(wsUrl, {
    perMessageDeflate: process.env.SOAK_NO_DEFLATE !== "1",
  });
  return newWebSocketRpcSession(ws);
}

// One write into computerd via the SyncRPC push path. senderRev=0
// marks us as an external writer — the server applies as
// a local write (bumps vfs_meta.rev, leaves pushRev alone) so
// the outbound sync loop picks the entry up on the next tick.
// This is the F2 fix in practice; before it landed, this
// path silenced the outbound loop and A never saw any of B's
// writes.
async function pushOneWrite(stub, i, bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  await stub.sync.pushObjects(
    new ReadableStream({
      start(c) {
        c.enqueue({ hash, bytes });
        c.close();
      },
    }),
  );
  await stub.sync.push({
    senderRev: 0,
    changes: new ReadableStream({
      start(c) {
        c.enqueue({
          kind: "file",
          path: `/soak_${i}.bin`,
          mode: 0o644,
          mtime: Date.now(),
          size: bytes.byteLength,
          chunks: [{ hash, size: bytes.byteLength }],
        });
        c.close();
      },
    }),
  });
}

async function main() {
  if (!DISABLE_FUSE) await ensureImage();

  process.stderr.write("booting A (sink) ...\n");
  const a = await bootContainer();
  process.stderr.write(`  A: ${a.url} (${a.cid.slice(0, 12)})\n`);

  process.stderr.write("booting B (source, UPSTREAM_URL -> A) ...\n");
  // B's sync loop will push to A. Hostname inside docker:
  // we can't reach the host's 127.0.0.1 portably; use
  // host.docker.internal which docker-desktop sets up on
  // macOS/Windows. On linux we'd need --add-host=host.docker.internal:host-gateway.
  // Inside a docker container we reach the host's mapped
  // port via host.docker.internal. The capnweb client needs
  // a ws:// URL pointing at the /ws endpoint (not just the
  // host).
  const upstreamForB = `${a.url.replace("http://127.0.0.1", "ws://host.docker.internal")}/ws`;
  // Inside the docker container, the host port we're trying
  // to reach is 127.0.0.1:<a.port> on the host. Pass the
  // mapped host port via host.docker.internal.
  const b = await bootContainer({
    UPSTREAM_URL: upstreamForB,
  });
  process.stderr.write(`  B: ${b.url} (${b.cid.slice(0, 12)}) -> upstream ${upstreamForB}\n`);

  // Header row.
  console.log(
    "t_ms\tA_currentRev\tA_pushRev\tA_fetchRev\tB_currentRev\tB_pushRev\tB_fetchRev\tA_mem\tB_mem\twrites_sent",
  );

  const start = Date.now();
  const stopAt = start + DURATION_MS;
  const intervalMs = Math.max(1, Math.floor(1000 / WRITES_PER_S));
  let writeSeq = 0;
  let writesSent = 0;
  let writesInFlight = 0;

  // Writes go through B's SyncRPC /ws push path with
  // senderRev=0. The server treats them as local writes;
  // B's outbound sync loop ships them to A on the next
  // tick. This is the path an external orchestrator (a
  // DO accepting agent requests, the agent itself) would
  // take — the same wire surface a computerd-to-computerd peer
  // uses, just with a different senderRev value.
  const writeStub = wsStub(b.url);

  // Fire-and-forget write loop. We don't await every write
  // because the goal is to saturate; we cap the in-flight
  // count to keep memory bounded.
  const MAX_INFLIGHT = 32;
  const writeLoop = (async () => {
    while (Date.now() < stopAt) {
      if (writesInFlight >= MAX_INFLIGHT) {
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }
      const i = writeSeq++;
      writesInFlight++;
      pushOneWrite(writeStub, i, payloadBytes(i))
        .then(() => {
          writesSent++;
          writesInFlight--;
        })
        .catch((err) => {
          writesInFlight--;
          process.stderr.write(`write ${i} failed: ${err.message}\n`);
        });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  // Sample loop. Runs in parallel with the writes.
  const samples = [];
  const sampleLoop = (async () => {
    while (Date.now() < stopAt + 5000) {
      const t = Date.now() - start;
      const [aWm, bWm, stats] = await Promise.all([
        fetchWatermarks(a.url).catch(() => null),
        fetchWatermarks(b.url).catch(() => null),
        dockerStats([a.cid, b.cid]).catch(() => ({})),
      ]);
      const aMem = stats[a.cid.slice(0, 12)] ?? "?";
      const bMem = stats[b.cid.slice(0, 12)] ?? "?";
      const row = [
        t,
        aWm?.currentRev ?? -1,
        aWm?.pushRev ?? -1,
        aWm?.fetchRev ?? -1,
        bWm?.currentRev ?? -1,
        bWm?.pushRev ?? -1,
        bWm?.fetchRev ?? -1,
        aMem,
        bMem,
        writesSent,
      ];
      console.log(row.join("\t"));
      samples.push(row);
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();

  await writeLoop;
  process.stderr.write(`writes done (${writesSent} sent, ${writesInFlight} still in flight)\n`);
  // Let in-flight writes drain.
  while (writesInFlight > 0) await new Promise((r) => setTimeout(r, 100));
  // Let the sync loop catch up.
  await new Promise((r) => setTimeout(r, 3000));
  await sampleLoop;

  // capnweb's WebSocket session doesn't expose an explicit
  // close on the stub; the container kill below tears it
  // down at the computerd end.
  await Promise.all([kill(a.cid), kill(b.cid)]);

  // Summary on stderr.
  const final = samples[samples.length - 1] ?? [];
  process.stderr.write(`\n--- soak complete ---\n`);
  process.stderr.write(`writes attempted: ${writeSeq}\n`);
  process.stderr.write(`writes acked:     ${writesSent}\n`);
  process.stderr.write(`final B.currentRev: ${final[4]}\n`);
  process.stderr.write(
    `final B.pushRev:    ${final[5]} (gap to currentRev: ${final[4] - final[5]})\n`,
  );
  process.stderr.write(
    `final A.fetchRev:   ${final[3]} (lag behind B.currentRev: ${final[4] - final[3]})\n`,
  );
  process.stderr.write(`final B mem:        ${final[8]}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
