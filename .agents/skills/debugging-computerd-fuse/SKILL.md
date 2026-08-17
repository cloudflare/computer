---
name: debugging-computerd-fuse
description: Debug computerd in real-FUSE mode end-to-end without workerd, vitest-pool-workers, or wrangler in the loop. Boot the linux-x64 binary in a privileged docker container, drive its capnweb /api endpoint from Node, simulate DO-side sync from a SQLiteTestStorage, and isolate FUSE-related deadlocks. Load when a real-FUSE bug reproduces locally but unit tests pass, when the harness vitest tests hang against a real container, or when you need to attribute a wedge to FUSE vs sync vs exec.
---

# Debugging computerd against real FUSE

This skill captures the recipe for isolating bugs in computerd that only
fire when the kernel-FUSE backend is the one wired up. Most unit
tests run against `SQLiteTestStorage` and an in-process VFS or the
userspace `FUSE_MOUNT=shim` polling driver — neither exercises the
kernel-FUSE callback path. Several production-only bugs (write
buffer never spilled to the VFS, `spawn(cwd=/mount)` deadlocks)
have shipped to `next` and not been caught by the regular suites
because the harness is hard to drive end-to-end from a dev box.

The workflow here bypasses workerd, wrangler, and the
vitest-pool-workers harness. It boots the computerd SEA binary in a real
docker container with `/dev/fuse` and SYS_ADMIN, and drives its
capnweb endpoints from a plain Node script.

## When to reach for this

- A user report of "wrote a file via FUSE, RPC reads see 0 bytes."
- A user report of "exec hangs forever" or "computerd `/health` stops
  responding after the first shell call."
- Adding a new computerd op (FUSE callback, sync RPC, runner feature)
  and you want a smoke test that doesn't depend on Docker-in-DO or
  Cloudflare Containers.
- The harness vitest suite (`packages/computer/src/test-harness/`)
  hangs at `ws.shell.exec` against the docker container and you
  need to attribute the wedge to computerd vs workerd vs the network
  shim.
- Confirming a fix actually settles in the deployed binary: the
  SEA build is what wrangler ships, and reproducing locally with
  the same binary is the only way to be sure.

## What you need

- Docker, with `/dev/fuse` and `--privileged` available. In Pi's
  sandbox this works through DinD; on a Linux dev box it works
  natively; on macOS you need `colima start --vm-type=vz` (the
  default qemu vm doesn't surface `/dev/fuse`).
- A fresh computerd binary at `artifacts/computerd/computerd-linux-x64`. Build it
  with `npm run build:bin --workspace @cloudflare/computerd`,
  or just `npm run build:all` from the repo root if you need the
  docker image too.

## Boot a real-FUSE computerd container

There's already a recipe — `packages/computer/test-harness/run-computerd.sh`.
It picks a host port, runs the binary with `--privileged
--device /dev/fuse --cap-add SYS_ADMIN --cap-add MKNOD`, installs
fuse3 + libfuse2t64 from apt, waits for `/health`, prints the URL
on stdout and the container id on stderr.

```bash
# Start
COMPUTERD_HARNESS_PORT=18080 bash packages/computer/test-harness/run-computerd.sh
# prints: http://127.0.0.1:18080      on stdout
# prints: COMPUTERD_HARNESS_CID=<id>        on stderr

# Verify
curl -sf http://127.0.0.1:18080/health
docker logs <CID> | tail
# should see: computerd listening on 0.0.0.0:8080 mount=/workspace backend=linux

# Tear down
docker kill <CID>
```

In a tmux session:

```bash
tmux new-session -d -s computerd \
  "COMPUTERD_HARNESS_PORT=18080 bash packages/computer/test-harness/run-computerd.sh; sleep 600"
for i in 1 2 3 4 5; do
  sleep 5
  if curl -sf http://127.0.0.1:18080/health 2>/dev/null; then echo ready; break; fi
done
```

**`backend=fuse` is the success signal.** If you see `backend=shim`
the FUSE mount didn't take and you're testing the wrong path.
`backend=none` means `FUSE_MOUNT=none` was set; `FUSE_MOUNT=fuse`
with a missing `/dev/fuse` would have failed startup outright.

## Drive computerd from a Node script

computerd serves a composite `WorkspaceRPC` over `/api`, a capnweb
WebSocket. That is the only RPC carrier: capnweb's HTTP batch transport
cannot deliver a returned stream, which is what every read on this
interface is. The `@cloudflare/computer-rpc/client` package wraps the
socket and the `/driver` subpath exposes `pushOnce`/`pullOnce` against a
Node-side `Database`.

Set up a probe project once:

```bash
mkdir -p /tmp/computerd-probe && cd /tmp/computerd-probe
cat > package.json <<'EOF'
{
  "type": "module",
  "private": true,
  "dependencies": {
    "@cloudflare/dofs": "file:/workspace/packages/dofs",
    "@cloudflare/computer-rpc": "file:/workspace/packages/rpc",
    "ws": "^8.18.0"
  }
}
EOF
npm install --ignore-scripts --no-audit --no-fund
```

Now you can write probes that hold both sides of the wire. The
canonical shape, with the WebSocket impl pinned to the `ws`
package (Node's built-in `WebSocket` doesn't negotiate the
permessage-deflate extension that computerd advertises):

```js
import { Database, WorkspaceFilesystem, initializeSchema } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { createWorkspaceClient } from "@cloudflare/computer-rpc/client";
import { pullOnce, pushOnce } from "@cloudflare/computer-rpc/driver";
import { WebSocket } from "ws";

const url = process.env.COMPUTERD_URL;                // e.g. http://127.0.0.1:18080
const wsUrl = `${url.replace(/^http(s?):\/\//, "ws$1://")}/api`;

const storage = new SQLiteTestStorage();
const db = new Database(storage);
initializeSchema(db, () => Date.now());
const fs = new WorkspaceFilesystem(db, { now: () => Date.now() });

// Stage some local state. IMPORTANT: paths must be inside the
// container's MOUNT_POINT (default /workspace) or computerd's FUSE
// driver won't surface them on the host — computerd serves only the
// `/workspace/...` subtree of vfs_nodes through the kernel mount.
await fs.mkdir("/workspace", { recursive: true });
await fs.writeFile("/workspace/probe.txt", "hello from probe");

const client = createWorkspaceClient({ url: wsUrl, WebSocketImpl: WebSocket });
try {
  const pushed = await pushOnce(db, client.sync);
  console.log("pushed", pushed);
  const result = await pullOnce(db, client.sync);
  console.log("pulled", result);
} finally {
  await client.close();
}
```

Run with `COMPUTERD_URL=http://127.0.0.1:18080 node probe.mjs`.

To verify the push actually landed on the FUSE side:

```bash
docker exec <CID> sh -c 'ls -la /workspace && cat /workspace/probe.txt'
```

If `ls /workspace` is empty but the push reported `pushed=N`, the
RPC apply path landed bytes in `vfs_nodes` but FUSE isn't surfacing
them. Check that:

- Your absolute paths start with `MOUNT_POINT` (default
  `/workspace`). Writing to `/probe.txt` succeeds at the RPC
  layer but FUSE only serves the `MOUNT_POINT` subtree.
- computerd actually logs `backend=linux` (not `backend=shim`).
- You aren't reading the wrong container — `docker ps` after a
  zombie `docker rm -f` can show stale entries.

## Drive container-side writes

The cleanest way to simulate a container-side FUSE write — the
exact path computerd was designed to handle — is `docker exec` into the
running container:

```bash
docker exec <CID> sh -c 'echo container-write > /workspace/r2/hello.txt'
```

This is a real FUSE write: kernel → fuse-native → computerd's
`writeBuf` op → computerd's in-memory buffer for that file → on
`release`/`flush`/`fsync` the buffer spills into the backing VFS
(commit `68407fc`). On the host side you can then `pullOnce` and
see the new entry land in `applyChanges`.

**Avoid `client.shell.exec()` while debugging FUSE bugs in this
environment.** It calls `spawn` with `cwd=MOUNT_POINT` by default,
which can deadlock under real FUSE (see "Known deadlock patterns"
below). If you need exec-shaped behaviour from outside the
container, `docker exec` is closer to what wrangler's container
runtime would do anyway — computerd isn't the parent of the spawned
process.

## Known deadlock patterns

### FUSE buffer never spilled to the VFS

Symptom: container `cat /workspace/foo` returns the bytes you
wrote, but a host-side `pullOnce` sees the file at size 0.

Mechanism: the FUSE driver in `packages/computerd/src/fuse/driver.ts`
buffers writes in an in-memory `files` Map keyed by path. Reads
through FUSE pull from that buffer, but the backing VFS only sees
the empty inode the `create` op registered. If `release` / `flush`
/ `fsync` don't spill the buffer, RPC consumers see an empty file.

Fix shipped: commit `68407fc` — `flushEntry(path)` runs on each
of those ops.

Test for it: `packages/computerd/src/fuse/driver.test.ts` and the
companion test at `8111d68`. Mirror that shape if you find a new
buffer-vs-VFS desync.

### computerd's event loop blocked in spawn

Symptom: `client.shell.exec` against a real-FUSE computerd hangs
forever. `/health` stops responding. `docker exec <CID> ls
/workspace` also hangs once the deadlock fires.

Mechanism: `Runner.exec` calls
`spawn("/bin/sh", { cwd: "/workspace" })`. libuv's `uv_spawn`
forks and waits on a status pipe for the child to exec. The
child, between fork and exec, does `chdir("/workspace")`. The
kernel issues a FUSE `LOOKUP` against the computerd mount. The callback
needs to run on computerd's event loop, which is blocked in the pipe
read. Deadlock.

Diagnostic:

```js
// against a fresh computerd
const t = Date.now();
await client.shell.exec({ command: "echo hi", cwd: "/tmp", timeoutMs: 5000 });
// returns in <100ms — control case
await client.shell.exec({ command: "echo hi", cwd: "/workspace", timeoutMs: 5000 });
// hangs forever — under real FUSE
```

Same computerd, same client, same network — only `cwd` differs. If
that flips success→hang, you've reproduced the deadlock.

Fix: do the chdir inside the **shell**, not inside `spawn`'s
fork-and-exec dance. Prefix the command with `cd ... && exec ...`
so the chdir runs after the shell is up and computerd's event loop is
responsive again. Pre-flight existence via dofs's `stat(db, path)`
(reads SQLite directly, no FUSE callbacks) to preserve the
existing ENOENT-cwd error contract.

### Other event-loop blockers to suspect

Any computerd code path that does sync work against
`MOUNT_POINT`/the FUSE mount can wedge: `fs.statSync(cwd)`,
`fs.readdirSync(MOUNT_POINT)`, `fs.realpathSync(...)` — all
synchronous, all block the event loop, all issue FUSE callbacks
to computerd itself. Rule of thumb when adding computerd code: anything that
goes through Node's `fs` against the mount point must be async
(so libuv's threadpool services the call) OR must read the dofs
`Database` / VFS directly (pure SQL, no FUSE involvement).

## Recipe library

### Reset between probes

A wedged computerd container can leave fuse-native zombie processes
that `docker kill` refuses to reap. The cleanest fix:

```bash
# Try kill first
docker kill <CID> 2>&1
# If it complains about a PID being a zombie, just abandon that
# port and pick a new one
COMPUTERD_HARNESS_PORT=18081 bash packages/computer/test-harness/run-computerd.sh
```

The zombie containers don't hold the host port once docker has
nominally released them, but they linger in `docker ps` until the
next daemon restart. Harmless for further work.

### Stage a read-only mount fixture

Mirrors what the workspace indexer does. Useful when reproducing
M3.5-class issues (read-only mount enforcement) without going
through the full Workspace constructor:

```js
import { Database, ROOT_INODE, WorkspaceFilesystem, initializeSchema, invalidateReadOnlyMountCache } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";

const storage = new SQLiteTestStorage();
const db = new Database(storage);
initializeSchema(db, () => Date.now());
const fs = new WorkspaceFilesystem(db);

const root = "/workspace/r2";
// Indexer step 1: row at read-write so writeFile can land
db.run("INSERT INTO _vfs_mounts (root, kind, mode, indexed) VALUES (?, ?, 'read-write', 0)", root, "fixture");
invalidateReadOnlyMountCache(db);

// Indexer step 2: materialize
await fs.mkdir(root, { recursive: true });
await fs.writeFile(`${root}/hello.txt`, "hello world");

// Indexer step 3: stamp mount_root on every inode under the root.
// Path-to-inode resolver:
function resolveInode(db, absPath) {
  const parts = absPath.split("/").filter(Boolean);
  let inode = ROOT_INODE;
  for (const part of parts) {
    const row = db.one("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?", inode, part);
    if (!row) return undefined;
    inode = row.child_inode;
  }
  return inode;
}
const rootInode = resolveInode(db, root);
const queue = [rootInode];
const subtree = [rootInode];
while (queue.length) {
  const parent = queue.shift();
  for (const c of db.all("SELECT child_inode FROM vfs_dirents WHERE parent_inode = ?", parent)) {
    subtree.push(c.child_inode);
    queue.push(c.child_inode);
  }
}
for (const inode of subtree) {
  db.run("UPDATE vfs_nodes SET mount_root = ? WHERE inode = ?", root, inode);
}

// Indexer step 4: flip to read-only and invalidate the cache
db.run("UPDATE _vfs_mounts SET mode = 'read-only', indexed = 1 WHERE root = ?", root);
invalidateReadOnlyMountCache(db);
```

After staging this and `pushOnce`'ing to computerd, the container's
FUSE view will surface `/workspace/r2/hello.txt`. Container-side
writes to that subtree will propagate back via the next
`pullOnce`, where `applyChanges` skips them with
`reason: "read-only"`.

### Reference: a full M3.5-style probe

A working end-to-end probe that stages the mount, pushes,
container-writes via `docker exec`, pulls, and asserts the
expected applied/skipped split lives at
`script/computerd-mount-probe.mjs` if it's still in the tree. Use it as
the template for new probes.

## What this skill is NOT

- Not a substitute for unit tests. Unit tests are still where
  fast feedback comes from; this is for the bugs only the kernel
  can reproduce.
- Not for benchmarking. Use `script/run-fs-bench.sh` for that.
- Not for testing the sync wire alone — `packages/rpc/tests/wire.test.ts`
  already covers WS round-trips with no FUSE in the loop.

## When to escalate

If you've isolated a wedge to computerd's event loop and the fix isn't
obvious from the patterns above, the next step is `node
--inspect-brk` against the computerd binary. The SEA bundle preserves
source maps for the bundled JS, so breakpoints in
`packages/computerd/src/exec/runner.ts` resolve. Run computerd outside docker
(it'll fall back to `backend=shim` or `backend=none` depending on
your host) so the inspector port is reachable, or `docker run
--publish 9229:9229 ...` and pass `--inspect-brk=0.0.0.0:9229`
through computerd's launch env.

If even that doesn't surface it, the wedge is probably below the
JS layer — in fuse-native or libuv. At that point reach for
`strace -fp <computerd-pid>` inside the container; the FUSE callbacks
all surface as `read(/dev/fuse, ...)` and the per-call timing
will show you exactly which op deadlocks.
