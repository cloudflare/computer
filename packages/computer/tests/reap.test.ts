// Reaping, end to end: a real Workspace in a SQLite-backed Durable
// Object, driven only through its public API over Durable Object RPC.
// The dofs unit tests cover the mechanics against Durable Object
// storage; these show the same behavior through the Workspace class,
// across requests, a restart and a sync with a second Durable Object.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env, ReapHost } from "./reap-worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const HOUR = 60 * 60 * 1000;
const CHUNK = 512 * 1024;

function host(name: string): DurableObjectStub<ReapHost> {
  return env.HOST.get(env.HOST.idFromName(name));
}

function unique(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

// Text of exactly `size` bytes, distinct per seed.
function text(size: number, seed: string): string {
  const unit = `${seed}:`;
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

describe("reaping through a Workspace in a Durable Object", () => {
  it("keeps one blob and a flat database across 1,000 saves of one file", async () => {
    const ws = host(unique("editor"));
    for (let save = 0; save < 10; save++) await ws.write("/notes.md", `draft ${save}`);
    const afterTen = await ws.stats();
    for (let save = 10; save < 1000; save++) await ws.write("/notes.md", `draft ${save}`);
    const afterThousand = await ws.stats();
    console.log(
      `editor: databaseSize after 10 saves ${afterTen.databaseSize}, after 1000 ${afterThousand.databaseSize}; blobs ${afterTen.blobs} -> ${afterThousand.blobs}`,
    );

    expect(await ws.read("/notes.md")).toBe("draft 999");
    expect(afterThousand.blobs).toBe(1);
    expect(afterThousand.manifests).toBe(1);
    // Freed pages are reused, so the file does not grow with the saves.
    expect(afterThousand.databaseSize - afterTen.databaseSize).toBeLessThanOrEqual(16 * 4096);
  });

  it("frees what rm, a rename over a file and a truncate drop, and keeps shared content", async () => {
    const ws = host(unique("drops"));
    await ws.write("/removed.txt", "removed");
    await ws.rm("/removed.txt");
    expect((await ws.stats()).blobs).toBe(0);

    await ws.write("/mover.txt", "mover");
    await ws.write("/displaced.txt", "displaced");
    await ws.rename("/mover.txt", "/displaced.txt");
    expect((await ws.stats()).blobs).toBe(1);
    expect(await ws.read("/displaced.txt")).toBe("mover");

    await ws.truncate("/displaced.txt", 0);
    expect((await ws.stats()).blobs).toBe(0);

    await ws.write("/a.txt", "shared");
    await ws.write("/b.txt", "shared");
    await ws.rm("/a.txt");
    expect(await ws.read("/b.txt")).toBe("shared");
    expect((await ws.stats()).blobs).toBe(1);
    expect(await ws.gcNow()).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
  });

  it("serves a lazy read across requests while the file is overwritten in between", async () => {
    const ws = host(unique("stream"));
    const original = text(CHUNK, "first") + text(CHUNK, "second") + text(100, "third");
    await ws.write("/big.txt", original);

    await ws.openStream("s", "/big.txt");
    await ws.pullStream("s");
    await ws.write("/big.txt", "replaced");
    await ws.write("/other.txt", "a later write");
    while (await ws.pullStream("s")) {
      await ws.write("/big.txt", `replaced again ${Math.random()}`);
    }

    expect(await ws.streamText("s")).toBe(original);
    expect(await ws.read("/big.txt")).not.toBe(original);
    expect((await ws.stats()).dangling).toBe(0);
  });

  it("reaps what a pin held through a restart, by the sweep", async () => {
    const name = unique("restart");
    let ws = host(name);
    await ws.write("/held.txt", text(CHUNK + 10, "held"));
    // A lazy read pins both chunks; the overwrite defers them.
    await ws.openStream("s", "/held.txt");
    await ws.write("/held.txt", "small now");
    expect((await ws.stats()).unreferencedBlobs).toBe(2);

    // The pin and the deferred set live in memory and die with it.
    await ws.restart().catch(() => undefined);
    ws = host(name);
    expect(await ws.read("/held.txt")).toBe("small now");
    expect((await ws.stats()).unreferencedBlobs).toBe(2);

    // The orphans are younger than the sweep's grace window. Age them
    // past it, then write until the sweep has gone round.
    await ws.ageContent(2 * HOUR);
    for (let i = 0; i < 20; i++) await ws.write("/busy.txt", `save ${i}`);

    const after = await ws.stats();
    expect(after.unreferencedBlobs).toBe(0);
    expect(after.dangling).toBe(0);
  });

  it("stays consistent with two clients interleaving writes and reads", async () => {
    const ws = host(unique("concurrent"));
    const paths = ["/x.txt", "/y.txt", "/z.txt"];
    for (const path of paths) await ws.write(path, `start ${path}`);

    async function client(label: string, rounds: number): Promise<void> {
      for (let round = 0; round < rounds; round++) {
        const path = paths[round % paths.length];
        const id = `${label}-${round}`;
        await Promise.all([
          ws.writeStreaming(path, [text(CHUNK, `${id}-a`), text(64, `${id}-b`)]),
          ws.write(paths[(round + 1) % paths.length], `${id} quick`),
          (async () => {
            if (!(await ws.openStream(id, path))) return;
            while (await ws.pullStream(id)) await ws.write("/noise.txt", `${id} noise`);
          })(),
          round % 3 === 2 ? ws.rm(paths[(round + 2) % paths.length]) : Promise.resolve(),
        ]);
        // A file the other client just removed reads as null; missing
        // bytes would throw.
        for (const p of paths) await ws.readIfPresent(p);
      }
    }

    await Promise.all([client("one", 12), client("two", 12)]);

    expect((await ws.stats()).dangling).toBe(0);
    // Every stream has ended, so nothing is pinned. A few writes retry
    // whatever was deferred, within the per-write budget.
    for (let i = 0; i < 40; i++) await ws.write("/settle.txt", `settle ${i}`);
    expect(await ws.gcNow()).toEqual({ blobsFreed: 0, manifestsFreed: 0 });
  });

  it("pulls from a peer Durable Object when a local overwrite lands between probe and apply", async () => {
    const ws = host(unique("pull"));
    const peerName = unique("peer");
    await ws.usePeer(peerName);
    const peer = env.PEER.get(env.PEER.idFromName(peerName));

    // The host already holds "shared" under another name, so the pull
    // will find it locally and skip fetching it. The peer also sends
    // content the host lacks, which makes the pull fetch, and the
    // overwrite runs at that moment: after the local probe, before the
    // apply, dropping the host's only copy of "shared".
    await ws.write("/local.txt", "shared");
    await peer.write("/from-peer.txt", "shared");
    await peer.write("/only-on-peer.txt", "new to the host");
    await ws.overwriteBetweenProbeAndApply("/local.txt", "overwritten locally");

    await ws.pull();

    expect(await ws.read("/from-peer.txt")).toBe("shared");
    expect(await ws.read("/only-on-peer.txt")).toBe("new to the host");
    expect(await ws.read("/local.txt")).toBe("overwritten locally");
    expect((await ws.stats()).dangling).toBe(0);
  });

  it("pushes to a Durable Object whose receiver nests transactions", async () => {
    const ws = host(unique("push"));
    const peerName = unique("receiver");
    const peer = env.PEER.get(env.PEER.idFromName(peerName));
    await ws.usePeer(peerName);
    await ws.write("/pushed.txt", "to the peer");

    await expect(ws.push()).resolves.toEqual({ ok: true });
    expect(await peer.read("/pushed.txt")).toBe("to the peer");
  });
});
