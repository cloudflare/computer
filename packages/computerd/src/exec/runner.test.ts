import { Database, initializeSchema, WorkspaceFilesystem } from "@cloudflare/dofs";
import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { expect, test } from "vitest";

import { Runner } from "./runner.js";

type ExecEvent =
  | { id: string; seq: number; name: "stdout"; value: Uint8Array }
  | { id: string; seq: number; name: "stderr"; value: Uint8Array }
  | { id: string; seq: number; name: "exit"; code: number };

function fixture(options: Record<string, unknown> = {}): {
  runner: InstanceType<typeof Runner>;
  db: Database;
  fs: WorkspaceFilesystem;
  dispose: () => void;
} {
  const storage = new SQLiteTestStorage();
  const db = new Database(storage);
  initializeSchema(db, () => Date.now());
  const fs = new WorkspaceFilesystem(db, { now: () => Date.now() });
  const runner = new Runner({ db, ...options });
  return {
    runner,
    db,
    fs,
    dispose: () => {
      runner.disposeAll();
      storage.close?.();
    },
  };
}

async function drain(stream: ReadableStream<ExecEvent>): Promise<ExecEvent[]> {
  const events: ExecEvent[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      events.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

test("exec captures stdout and propagates exit code", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("echo hello && echo world >&2 && exit 3");
    const events = await drain(handle.events);
    const stdout = events
      .filter((e) => e.name === "stdout")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const stderr = events
      .filter((e) => e.name === "stderr")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const exit = events.find((e) => e.name === "exit");
    expect(stdout).toBe("hello\n");
    expect(stderr).toBe("world\n");
    expect(exit?.code).toBe(3);
    // seq is monotonic per-id starting at 1.
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBeTruthy();
    }
    expect(seqs[0]).toBe(1);
  } finally {
    dispose();
  }
});

test("per-execution env overrides the base env without leaking to later commands", async () => {
  const { runner, dispose } = fixture({ env: { TOKEN: "base", BASE_ONLY: "yes" } });
  try {
    const first = runner.exec('printf \'%s|%s|%s\' "$TOKEN" "$BASE_ONLY" "$EMPTY"', {
      env: { TOKEN: "override", EMPTY: "" },
    });
    const firstEvents = await drain(first.events);
    const firstStdout = firstEvents
      .filter((event) => event.name === "stdout")
      .map((event) => decode(event.value as Uint8Array))
      .join("");
    expect(firstStdout).toBe("override|yes|");

    const second = runner.exec("printf '%s' \"$TOKEN\"");
    const secondEvents = await drain(second.events);
    const secondStdout = secondEvents
      .filter((event) => event.name === "stdout")
      .map((event) => decode(event.value as Uint8Array))
      .join("");
    expect(secondStdout).toBe("base");
  } finally {
    dispose();
  }
});

test("feeds per-execution stdin to the child and closes it", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("cat", { stdin: new TextEncoder().encode("piped-input") });
    const events = await drain(handle.events);
    const stdout = events
      .filter((event) => event.name === "stdout")
      .map((event) => decode(event.value as Uint8Array))
      .join("");
    const exit = events.find((event) => event.name === "exit");
    expect(stdout).toBe("piped-input");
    expect(exit?.code).toBe(0);
  } finally {
    dispose();
  }
});

test("reusing a live id throws EEXEC_BUSY", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.5", { id: "busy" });
    try {
      runner.exec("echo nope", { id: "busy" });
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("EEXEC_BUSY");
    }
    await drain(handle.events);
  } finally {
    dispose();
  }
});

test("get() replays a completed exec by seq", async () => {
  const { runner, dispose } = fixture();
  try {
    const first = runner.exec("printf 'a\\nb\\nc\\n'", { id: "replay" });
    const original = await drain(first.events);
    expect(original.length >= 2).toBeTruthy();

    // Resume from seq=0 — should get everything.
    const full = await drain(runner.get("replay", { after: 0 }).events);
    expect(full.length).toBe(original.length);
    expect(full.map((e) => e.seq)).toEqual(original.map((e) => e.seq));

    // Resume from seq=1 — should skip the first event.
    const tail = await drain(runner.get("replay", { after: 1 }).events);
    expect(tail.length).toBe(original.length - 1);
    expect(tail[0].seq).toBe(original[1].seq);
  } finally {
    dispose();
  }
});

test("get() throws ENOENT for unknown id", async () => {
  const { runner, dispose } = fixture();
  try {
    try {
      runner.get("never");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("kill() terminates a running exec", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 30", { id: "killme" });
    runner.kill("killme", "SIGTERM");
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    // SIGTERM → 143 per the mapping in runner.ts.
    expect(exit?.code).toBe(143);
  } finally {
    dispose();
  }
});

test("exec times out at timeoutMs and exits 143", async () => {
  const { runner, dispose } = fixture();
  try {
    // 100ms is short enough for a fast test but long enough to
    // exclude any plausible spawn-jitter false positive.
    const handle = runner.exec("sleep 30", { id: "slow", timeoutMs: 100 });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    // SIGTERM → 143 per mapExitCode.
    expect(exit?.code).toBe(143);
  } finally {
    dispose();
  }
});

test("exec uses defaultTimeoutMs from the runner when no per-call value", async () => {
  const { runner, dispose } = fixture({ defaultTimeoutMs: 100 });
  try {
    const handle = runner.exec("sleep 30", { id: "slow" });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit !== undefined).toBeTruthy();
    expect(exit?.code).toBe(143);
  } finally {
    dispose();
  }
});

test("per-call timeoutMs overrides the runner default", async () => {
  // Runner default is 5s; per-call 100ms must win.
  const { runner, dispose } = fixture({ defaultTimeoutMs: 5_000 });
  try {
    const start = Date.now();
    const handle = runner.exec("sleep 30", { id: "override", timeoutMs: 100 });
    await drain(handle.events);
    expect(Date.now() - start < 2_000).toBeTruthy();
  } finally {
    dispose();
  }
});

test("timeoutMs: 0 disables the timeout", async () => {
  const { runner, dispose } = fixture({ defaultTimeoutMs: 50 });
  try {
    // The 50ms default would kill this; 0 must override to disable.
    const handle = runner.exec("echo hi", { id: "noto", timeoutMs: 0 });
    const events = await drain(handle.events);
    const exit = events.find((e) => e.name === "exit");
    expect(exit?.code).toBe(0);
  } finally {
    dispose();
  }
});

test("dispose() removes the log and subsequent get() throws ENOENT", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("echo done", { id: "gone" });
    await drain(handle.events);
    runner.dispose("gone");
    try {
      runner.get("gone");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("log eviction past maxBytes yields ELOG_TRUNCATED on replay", async () => {
  // Tight cap forces an evict on the first kilobyte of stdout.
  const { runner, dispose } = fixture({ logMaxBytes: 512 });
  try {
    const handle = runner.exec(
      // Generate 2 KiB of output — well over the cap.
      "head -c 2048 /dev/urandom | base64",
      { id: "evict" },
    );
    const events = await drain(handle.events);
    // Live stream still saw events (eviction doesn't gate live).
    expect(events.some((e) => e.name === "stdout")).toBeTruthy();
    // Replay should fail with ELOG_TRUNCATED. The throw happens
    // inside the pull callback when we walk the (gone) log rows.
    let caught: unknown;
    try {
      await drain(runner.get("evict", { after: 0 }).events);
    } catch (err) {
      caught = err;
    }
    expect(caught !== undefined).toBeTruthy();
    expect((caught as { code?: string }).code).toBe("ELOG_TRUNCATED");
  } finally {
    dispose();
  }
});

test("retention sweep evicts records past TTL", async () => {
  let nowMs = 1_000_000;
  const { runner, dispose } = fixture({
    now: () => nowMs,
    retentionMs: 100,
  });
  try {
    const handle = runner.exec("echo bye", { id: "ttl" });
    await drain(handle.events);
    // Advance past the TTL window and sweep.
    nowMs += 500;
    runner.sweep();
    try {
      runner.get("ttl");
      throw new Error("expected to throw");
    } catch (err) {
      expect((err as ExecError).code).toBe("ENOENT");
    }
  } finally {
    dispose();
  }
});

test("exit-event surfaces an error on the subscriber when setExit throws", async () => {
  // Simulate the log row vanishing between exec start and child exit.
  // Previously this swallowed the exit event and the subscriber's
  // stream hung forever. Now the subscriber should see its stream
  // error out instead.
  const { runner, db, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.1", { id: "setexit-throws" });
    // Drop the meta row out from under the runner. setExit() will
    // throw 'setExit after dispose' when the child exits.
    db.run("DELETE FROM computerd_exec_meta WHERE exec_id = ?", "setexit-throws");
    db.run("DELETE FROM computerd_exec_log WHERE exec_id = ?", "setexit-throws");

    let caught: unknown;
    const reader = handle.events.getReader();
    try {
      while (true) {
        try {
          const { done } = await reader.read();
          if (done) break;
        } catch (err) {
          caught = err;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    expect(caught instanceof Error).toBeTruthy();
    expect((caught as Error).message).toMatch(/setExit after dispose/);
  } finally {
    dispose();
  }
});

test("exec(cwd) does not pass cwd to spawn; threads it through the shell", async () => {
  // Pre-flighting via dofs's stat means the cwd must exist as a
  // directory in the local Database. The shell then `cd`s into it,
  // which requires the same path to exist on the host filesystem
  // (the spawned /bin/sh runs against the OS, not the dofs VFS).
  // /tmp is both: a real directory the OS knows about, and one we
  // can mkdir into the dofs DB without escaping the sandbox.
  const { runner, fs, dispose } = fixture();
  try {
    await fs.mkdir("/tmp", { recursive: true });
    const handle = runner.exec("pwd", { cwd: "/tmp" });
    const events = await drain(handle.events);
    const stdout = events
      .filter((e) => e.name === "stdout")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const exit = events.find((e) => e.name === "exit");
    expect(stdout.trim()).toBe("/tmp");
    expect(exit?.code).toBe(0);
  } finally {
    dispose();
  }
});

test("exec(cwd) with a missing path synthesises a spawn-failed shape", async () => {
  // dofs's stat throws ENOENT for a path that doesn't exist in the
  // local Database. The runner converts that into the same
  // stderr-then-exit-(-1) shape it produces when libuv emits a
  // real spawn error event, so the externally observable contract
  // is identical regardless of which side caught the failure.
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("echo unreachable", { cwd: "/nope/missing" });
    const events = await drain(handle.events);
    const stderr = events
      .filter((e) => e.name === "stderr")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const exit = events.find((e) => e.name === "exit");
    expect(stderr).toMatch(/^spawn failed: /);
    expect(stderr).toMatch(/no such path|ENOENT/i);
    expect(exit?.code).toBe(-1);
  } finally {
    dispose();
  }
});

test("exec(cwd) quotes path segments with spaces and single quotes", async () => {
  // The shellQuote helper has to survive both spaces and embedded
  // single quotes without giving /bin/sh a chance to misparse. Use
  // a real on-disk path so the spawned shell can actually cd to
  // it, and mkdir the matching entry into the dofs DB so the
  // pre-flight passes.
  const { runner, fs, dispose } = fixture();
  const tricky = "/tmp/computerd test 'quoted' dir";
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(tricky, { recursive: true });
    await fs.mkdir(tricky, { recursive: true });
    const handle = runner.exec("pwd", { cwd: tricky });
    const events = await drain(handle.events);
    const stdout = events
      .filter((e) => e.name === "stdout")
      .map((e) => decode(e.value as Uint8Array))
      .join("");
    const exit = events.find((e) => e.name === "exit");
    expect(stdout.trim()).toBe(tricky);
    expect(exit?.code).toBe(0);
  } finally {
    dispose();
  }
});

test("runner emits heartbeat events at the configured interval", async () => {
  // A command that sleeps long enough to produce at least two
  // heartbeat ticks at a 50ms interval. We drain the stream, pick
  // out the heartbeat events, and verify the shape rather than
  // exact timing to stay deterministic under load.
  const { runner, dispose } = fixture({ heartbeatIntervalMs: 50 });
  try {
    const handle = runner.exec("sleep 0.3", { id: "hb" });
    const events = await drain(handle.events);

    const heartbeats = events.filter((e) => e.name === "heartbeat");
    expect(heartbeats.length >= 2).toBeTruthy();

    const first = heartbeats[0] as {
      id: string;
      seq: number;
      name: "heartbeat";
      value: { pid: number; elapsedMs: number; lastOutputMs: number };
    };
    expect(typeof first.value.pid).toBe("number");
    expect(first.value.pid > 0).toBeTruthy();
    expect(typeof first.value.elapsedMs).toBe("number");
    expect(first.value.elapsedMs >= 0).toBeTruthy();
    expect(typeof first.value.lastOutputMs).toBe("number");
  } finally {
    dispose();
  }
});

test("heartbeat events are not emitted when heartbeatIntervalMs is not set", async () => {
  const { runner, dispose } = fixture();
  try {
    const handle = runner.exec("sleep 0.1", { id: "nohb" });
    const events = await drain(handle.events);
    const heartbeats = events.filter((e) => e.name === "heartbeat");
    expect(heartbeats.length).toBe(0);
  } finally {
    dispose();
  }
});

test("heartbeat elapsedMs grows monotonically across ticks", async () => {
  const { runner, dispose } = fixture({ heartbeatIntervalMs: 40 });
  try {
    const handle = runner.exec("sleep 0.25", { id: "hbmono" });
    const events = await drain(handle.events);

    const heartbeats = events.filter((e) => e.name === "heartbeat") as Array<{
      id: string;
      seq: number;
      name: "heartbeat";
      value: { pid: number; elapsedMs: number; lastOutputMs: number };
    }>;
    expect(heartbeats.length >= 2).toBeTruthy();
    for (let i = 1; i < heartbeats.length; i++) {
      expect(heartbeats[i].value.elapsedMs >= heartbeats[i - 1].value.elapsedMs).toBeTruthy();
    }
  } finally {
    dispose();
  }
});

test("heartbeat seq is monotonically increasing with other events", async () => {
  const { runner, dispose } = fixture({ heartbeatIntervalMs: 30 });
  try {
    const handle = runner.exec("sleep 0.15 && echo hi", { id: "hbseq" });
    const events = await drain(handle.events);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i] > seqs[i - 1]).toBeTruthy();
    }
  } finally {
    dispose();
  }
});
