// The rpc push receiver, applying batches into a Database on a Durable
// Object's own storage. It wraps each batch in one transactionSync, so
// every filesystem write inside the batch runs as a nested transaction.

import { env } from "cloudflare:test";
import type { ChangeEntry } from "@cloudflare/dofs";
import { describe, expect, it } from "vitest";

import type { Env, Receiver } from "./sync-receiver-worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function receiver(): DurableObjectStub<Receiver> {
  return env.RECEIVER.get(env.RECEIVER.idFromName(crypto.randomUUID()));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function file(
  path: string,
  text: string,
  rev: number,
): Promise<{ entry: ChangeEntry; object: { hash: Uint8Array; bytes: Uint8Array } }> {
  const bytes = new TextEncoder().encode(text);
  const hash = await sha256(bytes);
  return {
    entry: {
      kind: "file",
      rev,
      path,
      mode: 0o644,
      mtime: 1,
      size: bytes.byteLength,
      chunks: [{ hash, size: bytes.byteLength }],
    },
    object: { hash, bytes },
  };
}

describe("rpc push receiver in a Durable Object", () => {
  it("applies a batch of directories, files, a rename and a delete", async () => {
    const stub = receiver();
    await stub.write("/old.txt", "moves");
    const a = await file("/d/a.txt", "alpha", 1);
    const moved = await file("/new.txt", "moves", 1);

    const result = await stub.receive(
      1,
      [a.object],
      [
        { kind: "dir", rev: 1, path: "/d", mode: 0o755, mtime: 1 },
        a.entry,
        { kind: "delete", rev: 1, path: "/old.txt" },
        moved.entry,
      ],
    );

    expect(result).toEqual({ ok: true, applied: 4 });
    expect(await stub.read("/d/a.txt")).toBe("alpha");
    expect(await stub.read("/new.txt")).toBe("moves");
    expect(await stub.read("/old.txt")).toBeNull();
  });

  it("rolls the whole batch back when one entry fails", async () => {
    const stub = receiver();
    await stub.write("/kept.txt", "kept");
    const landed = await file("/landed.txt", "would land", 1);
    const missing = await file("/missing.txt", "never sent", 1);

    // The second file's bytes are never pushed, so the batch fails
    // after the first file and the delete have already applied.
    const result = await stub.receive(
      1,
      [landed.object],
      [landed.entry, { kind: "delete", rev: 1, path: "/kept.txt" }, missing.entry],
    );

    expect(result.ok).toBe(false);
    expect(await stub.read("/landed.txt")).toBeNull();
    expect(await stub.read("/kept.txt")).toBe("kept");
  });
});
