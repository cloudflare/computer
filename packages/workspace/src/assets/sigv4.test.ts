import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { presignUrl, sha256Hex, sha256HexStream, signingKey } from "./sigv4.js";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

describe("signingKey", () => {
  // AWS-published derivation vector:
  // https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html
  // secret "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", date
  // 20150830, region us-east-1, service iam.
  it("matches the AWS documentation derivation vector", () => {
    const key = signingKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20150830",
      "us-east-1",
      "iam",
    );
    expect(toHex(key)).toBe("c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9");
  });
});

describe("sha256Hex", () => {
  it("hashes the empty string to the known SHA-256 constant", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("presignUrl", () => {
  const base = {
    endpoint: "https://acct123.r2.cloudflarestorage.com",
    bucket: "assets",
    key: "agent-x/abc/image.png",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    expiresIn: 30,
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
  };

  it("targets the right host, bucket, and key path", () => {
    const url = new URL(presignUrl(base));
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/assets/agent-x/abc/image.png");
  });

  it("includes the required SigV4 query parameters", () => {
    const url = new URL(presignUrl(base));
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("30");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260102T030405Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const cred = url.searchParams.get("X-Amz-Credential");
    expect(cred).toBe("AKIDEXAMPLE/20260102/auto/s3/aws4_request");
  });

  it("is deterministic for a fixed clock and inputs", () => {
    expect(presignUrl(base)).toBe(presignUrl(base));
  });

  it("changes the signature when the clock advances", () => {
    const later = { ...base, now: () => base.now() + 86_400_000 };
    const sigA = new URL(presignUrl(base)).searchParams.get("X-Amz-Signature");
    const sigB = new URL(presignUrl(later)).searchParams.get("X-Amz-Signature");
    expect(sigA).not.toBe(sigB);
  });

  it("changes the signature when the key changes", () => {
    const other = { ...base, key: "agent-x/def/image.png" };
    const sigA = new URL(presignUrl(base)).searchParams.get("X-Amz-Signature");
    const sigB = new URL(presignUrl(other)).searchParams.get("X-Amz-Signature");
    expect(sigA).not.toBe(sigB);
  });

  it("percent-encodes reserved characters in the key but keeps slashes", () => {
    // The slashes between key segments stay literal; the space and
    // plus inside segments are percent-encoded.
    expect(presignUrl({ ...base, key: "a b/c+d/e.png" })).toContain("/assets/a%20b/c%2Bd/e.png");
  });
});

describe("sha256HexStream", () => {
  function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
  }

  it("matches a one-shot hash of the concatenated chunks", async () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([6, 7, 8]);
    const c = new Uint8Array([9]);
    const joined = new Uint8Array([...a, ...b, ...c]);
    const oneShot = createHash("sha256").update(joined).digest("hex");
    expect(await sha256HexStream(streamOf(a, b, c))).toBe(oneShot);
  });

  it("hashes an empty stream to the SHA-256 of empty input", async () => {
    expect(await sha256HexStream(streamOf())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("handles a large multi-chunk stream without buffering", async () => {
    const chunks: Uint8Array[] = [];
    const hash = createHash("sha256");
    for (let i = 0; i < 256; i++) {
      const chunk = new Uint8Array(64 * 1024).fill(i & 0xff);
      chunks.push(chunk);
      hash.update(chunk);
    }
    expect(await sha256HexStream(streamOf(...chunks))).toBe(hash.digest("hex"));
  });
});
