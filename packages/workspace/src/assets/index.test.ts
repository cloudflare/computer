import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../workspace.js";
import { createAssets, resolveS3 } from "./index.js";

// Captures every put() so tests can assert on the key, the bytes
// streamed in, and the metadata — without a real R2.
interface CapturedPut {
  key: string;
  bytes: Uint8Array;
  isStream: boolean;
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

function fakeBucket(): { bucket: { put: unknown }; puts: CapturedPut[] } {
  const puts: CapturedPut[] = [];
  const bucket = {
    async put(
      key: string,
      value: ReadableStream<Uint8Array>,
      options?: {
        httpMetadata?: { contentType?: string; contentDisposition?: string };
        customMetadata?: Record<string, string>;
      },
    ) {
      const isStream = value instanceof ReadableStream;
      const reader = value.getReader();
      const parts: Uint8Array[] = [];
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        if (chunk) parts.push(chunk);
      }
      reader.releaseLock();
      let len = 0;
      for (const p of parts) len += p.byteLength;
      const bytes = new Uint8Array(len);
      let off = 0;
      for (const p of parts) {
        bytes.set(p, off);
        off += p.byteLength;
      }
      puts.push({
        key,
        bytes,
        isStream,
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
      return {};
    },
  };
  return { bucket, puts };
}

const s3 = {
  bucket: "assets",
  accountId: "acct123",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

function makeWorkspace(sessionId = "sess-1"): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), sessionId });
}

// writeFile requires the parent directory to exist; create it then
// write the bytes.
async function writeAt(ws: Workspace, path: string, bytes: Uint8Array): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir.length > 0) await ws.fs.mkdir(dir, { recursive: true });
  await ws.fs.writeFile(path, bytes);
}

const fixedClock = () => Date.UTC(2026, 0, 2, 3, 4, 5);

describe("createAssets.share", () => {
  it("uploads the VFS file's bytes as a stream", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/out/image.png", new TextEncoder().encode("PNGDATA"));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await assets.share("/workspace/out/image.png", { expiresAfter: 30_000 });

    expect(puts).toHaveLength(1);
    expect(puts[0].isStream).toBe(true);
    expect(new TextDecoder().decode(puts[0].bytes)).toBe("PNGDATA");
  });

  it("builds a key of prefix/id/basename without the full path", async () => {
    const ws = makeWorkspace("sess-9");
    await writeAt(ws, "/workspace/deep/nested/photo.jpg", new Uint8Array([1, 2, 3]));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await assets.share("/workspace/deep/nested/photo.jpg", {
      expiresAfter: 30_000,
      prefix: "/agent-sess-9/",
    });

    expect(puts[0].key).toMatch(/^agent-sess-9\/[0-9a-z]{26}\/photo\.jpg$/);
    expect(puts[0].key).not.toContain("deep");
    expect(puts[0].key).not.toContain("nested");
  });

  it("produces a unique key each time the same file is shared", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/a.png", new Uint8Array([0]));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await assets.share("/workspace/a.png", { expiresAfter: 30_000 });
    await assets.share("/workspace/a.png", { expiresAfter: 30_000 });

    expect(puts[0].key).not.toBe(puts[1].key);
  });

  it("sets content type, disposition, and custom metadata", async () => {
    const ws = makeWorkspace("sess-meta");
    await writeAt(ws, "/workspace/out/image.png", new Uint8Array([1]));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await assets.share("/workspace/out/image.png", { expiresAfter: 30_000 });

    expect(puts[0].httpMetadata?.contentType).toBe("image/png");
    expect(puts[0].httpMetadata?.contentDisposition).toBe('inline; filename="image.png"');
    expect(puts[0].customMetadata?.sourcePath).toBe("/workspace/out/image.png");
    expect(puts[0].customMetadata?.sessionId).toBe("sess-meta");
    // 30s after the fixed clock.
    expect(puts[0].customMetadata?.expiresAt).toBe("2026-01-02T03:04:35.000Z");
  });

  it("honours contentType, filename, and disposition overrides", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/data.bin", new Uint8Array([1]));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await assets.share("/workspace/data.bin", {
      expiresAfter: 30_000,
      contentType: "image/png",
      filename: "renamed.png",
      disposition: "attachment",
    });

    expect(puts[0].httpMetadata?.contentType).toBe("image/png");
    expect(puts[0].httpMetadata?.contentDisposition).toBe('attachment; filename="renamed.png"');
  });

  it("returns a presigned URL pointing at the uploaded key", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/out/image.png", new Uint8Array([1]));
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    const url = await assets.share("/workspace/out/image.png", { expiresAfter: 30_000 });
    const parsed = new URL(url);

    expect(parsed.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe(`/assets/${puts[0].key}`);
    expect(parsed.searchParams.get("X-Amz-Expires")).toBe("30");
    expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rounds a sub-second expiry up to one second", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/a.png", new Uint8Array([1]));
    const { bucket } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    const url = await assets.share("/workspace/a.png", { expiresAfter: 500 });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("1");
  });

  it("rejects a non-positive expiry", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/a.png", new Uint8Array([1]));
    const { bucket } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await expect(assets.share("/workspace/a.png", { expiresAfter: 0 })).rejects.toThrow(
      /expiresAfter/,
    );
  });

  it("rejects a NaN expiry", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/a.png", new Uint8Array([1]));
    const { bucket } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await expect(assets.share("/workspace/a.png", { expiresAfter: Number.NaN })).rejects.toThrow(
      /expiresAfter/,
    );
  });

  it("caps the expiry at seven days", async () => {
    const ws = makeWorkspace();
    await writeAt(ws, "/workspace/a.png", new Uint8Array([1]));
    const { bucket } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    // Ask for 30 days; the presigned URL is capped at 7 days
    // (604800 seconds), the maximum a presigned URL allows.
    const url = await assets.share("/workspace/a.png", {
      expiresAfter: 30 * 24 * 60 * 60 * 1000,
    });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  it("rejects a missing file without calling put", async () => {
    const ws = makeWorkspace();
    const { bucket, puts } = fakeBucket();
    const assets = createAssets({ ws, bucket: bucket as never, s3, now: fixedClock });

    await expect(
      assets.share("/workspace/does-not-exist.png", { expiresAfter: 30_000 }),
    ).rejects.toThrow();
    expect(puts).toHaveLength(0);
  });
});

describe("resolveS3", () => {
  it("derives credentials, account, and endpoint from env", () => {
    const resolved = resolveS3(
      { bucket: "b" },
      {
        CLOUDFLARE_ACCOUNT_ID: "acct999",
        R2_ACCESS_KEY_ID: "AKID",
        R2_SECRET_ACCESS_KEY: "SECRET",
      },
    );
    expect(resolved.accessKeyId).toBe("AKID");
    expect(resolved.secretAccessKey).toBe("SECRET");
    expect(resolved.endpoint).toBe("https://acct999.r2.cloudflarestorage.com");
  });

  it("falls back to AWS_* credential vars", () => {
    const resolved = resolveS3(
      { bucket: "b", endpoint: "https://example.com" },
      { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" },
    );
    expect(resolved.accessKeyId).toBe("AK");
    expect(resolved.secretAccessKey).toBe("SK");
  });

  it("lets explicit s3 fields win over env", () => {
    const resolved = resolveS3(
      { bucket: "b", accessKeyId: "explicit", secretAccessKey: "x", endpoint: "https://e" },
      { R2_ACCESS_KEY_ID: "fromenv" },
    );
    expect(resolved.accessKeyId).toBe("explicit");
  });

  it("throws when the access key id cannot be found", () => {
    expect(() => resolveS3({ bucket: "b", endpoint: "https://e" }, {})).toThrow(/access key id/);
  });

  it("throws when the secret access key cannot be found", () => {
    expect(() =>
      resolveS3({ bucket: "b", endpoint: "https://e" }, { R2_ACCESS_KEY_ID: "AK" }),
    ).toThrow(/secret access key/);
  });

  it("throws when the endpoint cannot be derived", () => {
    // Credentials present but no endpoint and no account id to
    // derive one from.
    expect(() =>
      resolveS3({ bucket: "b" }, { R2_ACCESS_KEY_ID: "AK", R2_SECRET_ACCESS_KEY: "SK" }),
    ).toThrow(/endpoint/);
  });
});
