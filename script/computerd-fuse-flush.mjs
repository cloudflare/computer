#!/usr/bin/env node

// End-to-end verification that computerd's FUSE driver spills its
// in-memory write buffer into the backing VFS so capnweb-side
// pullOnce sees the bytes. Reproduces the production container
// failure (FUSE-write \u2192 RPC-read returns 0 bytes) locally against
// a freshly-built computerd binary.
//
// Boots one computerd container with FUSE mounted on /workspace, writes
// a file inside the container via `docker exec` (kernel \u2192 FUSE
// driver \u2192 in-memory buffer \u2192 release/flush spill), then dials
// the container's WebSocket from the host, calls pullOnce, and
// reads the file back through the SQLiteWorkspaceProvider on a
// fresh receiver DB.
//
// Knobs:
//   COMPUTERD_BINARY   path to computerd-linux-x64 (default artifacts/computerd/...)
//   KEEP=1       leave the container running on failure for poking

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BINARY =
  process.env.COMPUTERD_BINARY ?? resolve(REPO_ROOT, "artifacts/computerd/computerd-linux-x64");
const KEEP = process.env.KEEP === "1";

if (!existsSync(BINARY)) {
  console.error(`computerd binary not found at ${BINARY}`);
  console.error("run `npm run build:bin --workspace @cloudflare/computerd` first");
  process.exit(2);
}

const ADD_HOST_GATEWAY = process.platform === "linux";

async function bootContainer() {
  const args = [
    "run",
    "--rm",
    "-d",
    "--platform",
    "linux/amd64",
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
  ];
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
    "debian:stable-slim",
    "bash",
    "-c",
    // libfuse2 + a long-lived shell so we can `docker exec` into the
    // same mount namespace where computerd mounted FUSE. computerd backgrounds
    // and we tail /tmp/computerd.log for debugging.
    "apt-get update >/dev/null 2>&1 && " +
      "apt-get install -y --no-install-recommends fuse3 libfuse2t64 >/dev/null 2>&1 && " +
      "mkdir -p /workspace && " +
      "/usr/local/bin/computerd >/tmp/computerd.log 2>&1 & " +
      "COMPUTERD_PID=$!; " +
      "trap 'kill $COMPUTERD_PID 2>/dev/null' EXIT; " +
      "wait $COMPUTERD_PID",
  );
  const { stdout } = await execFileP("docker", args);
  const cid = stdout.trim();
  const { stdout: portOut } = await execFileP("docker", ["port", cid, "8080/tcp"]);
  const port = Number(portOut.split("\n")[0].split(":").pop());
  const url = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return { cid, url, port };
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`container ${cid} did not become healthy within 60s`);
}

async function dockerExec(cid, ...cmd) {
  const { stdout, stderr } = await execFileP("docker", ["exec", cid, ...cmd]);
  return { stdout, stderr };
}

async function killContainer(cid) {
  if (KEEP) {
    console.error(`KEEP=1 set; leaving container ${cid} running`);
    return;
  }
  try {
    await execFileP("docker", ["kill", cid]);
  } catch {
    /* already dead */
  }
}

async function main() {
  process.stderr.write("booting computerd container ...\n");
  const container = await bootContainer();
  process.stderr.write(`  ${container.url} (${container.cid.slice(0, 12)})\n`);

  let failed = false;
  try {
    // 1. Confirm FUSE actually mounted; the rest of the test is
    //    meaningless against a fallback to the container's root fs.
    const { stdout: mount } = await dockerExec(container.cid, "mount");
    if (!/fuse on \/workspace/.test(mount)) {
      throw new Error(`FUSE not mounted in container:\n${mount}`);
    }
    process.stderr.write("  FUSE mounted on /workspace\n");

    // 2. Write through FUSE. echo > triggers FUSE create, write,
    //    flush (on close), release \u2014 every spill point landed in
    //    the 68407fc fix.
    const payload = `from-fuse ${Date.now()}\n`;
    await dockerExec(container.cid, "bash", "-c", `printf '%s' '${payload}' > /workspace/x.txt`);
    process.stderr.write(`  wrote ${payload.trim()} to /workspace/x.txt via FUSE\n`);

    // 3. Pull from the container's WebSocket on the host. Mirrors
    //    what the host DO does after exec returns.
    const { createWorkspaceClient } = await import(
      `${REPO_ROOT}/node_modules/@cloudflare/computer-rpc/dist/client.js`
    );
    const { Database, SQLiteWorkspaceProvider, initializeSchema } = await import(
      `${REPO_ROOT}/node_modules/@cloudflare/dofs/dist/index.js`
    );
    const { SQLiteTestStorage } = await import(
      `${REPO_ROOT}/node_modules/@cloudflare/dofs/dist/testing.js`
    );
    const { pullOnce } = await import(
      `${REPO_ROOT}/node_modules/@cloudflare/computer-rpc/dist/sync-driver.js`
    );

    const wsUrl = `${container.url.replace("http://", "ws://")}/api`;
    const client = createWorkspaceClient({ url: wsUrl });

    const recvStorage = new SQLiteTestStorage();
    const recvDb = new Database(recvStorage);
    initializeSchema(recvDb, () => Date.now());

    try {
      const applied = await pullOnce(recvDb, client.sync);
      process.stderr.write(`  pullOnce applied ${applied} entries\n`);
      if (applied === 0) {
        throw new Error("pullOnce applied 0 entries; expected at least 1 for /x.txt");
      }

      // 4. Read the file back through the receiver-side provider.
      //    The bytes have to match what we wrote through FUSE.
      const provider = new SQLiteWorkspaceProvider(recvDb, { now: () => Date.now() });
      const back = provider.readFileSync("/x.txt", "utf8");
      if (back !== payload) {
        throw new Error(
          `byte mismatch:\n  wrote: ${JSON.stringify(payload)}\n  read:  ${JSON.stringify(back)}`,
        );
      }
      process.stderr.write(`  pull-back matches: ${JSON.stringify(back.trim())}\n`);
    } finally {
      await client.close();
      recvStorage.close();
    }

    process.stderr.write("\nPASS: FUSE write reached the host via pullOnce\n");
  } catch (err) {
    failed = true;
    process.stderr.write(`\nFAIL: ${err.message}\n`);

    // Dump computerd's logs to help diagnose.
    try {
      const { stdout } = await dockerExec(container.cid, "cat", "/tmp/computerd.log");
      process.stderr.write(`\n--- computerd logs ---\n${stdout}\n----------------\n`);
    } catch {
      /* container might already be dead */
    }
  } finally {
    await killContainer(container.cid);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
