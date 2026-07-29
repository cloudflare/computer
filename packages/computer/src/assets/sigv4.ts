// Minimal AWS Signature Version 4, query-string ("presigned URL")
// flavour, scoped to what R2's S3-compatible endpoint needs.
//
// We don't pull a dependency for this. The whole algorithm is a
// handful of HMAC-SHA256 steps over deterministic strings, and the
// R2 surface only needs the presigned-GET path. Rolling it here
// also lets us keep a streaming payload-hash helper that hashes a
// ReadableStream incrementally — the piece a buffering library
// like aws4fetch can't give us — for the day we sign upload
// payloads directly.
//
// Reference:
// https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

// RFC 3986 unreserved set; everything else is percent-encoded.
// encodeURIComponent leaves !*'()~ unescaped and escapes ~, so we
// fix up both directions by hand to match AWS's expectations.
function uriEncode(input: string, encodeSlash: boolean): string {
  let out = "";
  for (const ch of input) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += ch;
    } else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

// Exported for tests, which validate it against AWS's published
// SigV4 vectors. Not part of the package's public surface.
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

// yyyymmddThhmmssZ (basic ISO 8601, no separators) and the yyyymmdd
// date stamp used in the credential scope.
function formatAmzDate(epochMs: number): { amzDate: string; dateStamp: string } {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return {
    amzDate: `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`,
    dateStamp: `${yyyy}${mm}${dd}`,
  };
}

// Exported for tests against AWS's published signing-key vector.
// Not part of the package's public surface.
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Uint8Array {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface PresignOptions {
  // Bucket endpoint origin, e.g.
  // https://<accountId>.r2.cloudflarestorage.com — no trailing
  // slash, no bucket.
  endpoint: string;
  bucket: string;
  // Object key. May contain slashes; each segment is encoded but
  // the slashes are preserved in the path.
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Lifetime of the URL in seconds. AWS caps presigned URLs at
  // 7 days (604800).
  expiresIn: number;
  method?: string; // default GET
  region?: string; // default "auto" (R2)
  service?: string; // default "s3"
  now?: () => number; // injectable clock; default Date.now
}

// Build a presigned URL. For GET the payload is unsigned
// (UNSIGNED-PAYLOAD), so no request body is read or hashed: the URL
// is a pure function of the inputs and the clock.
export function presignUrl(options: PresignOptions): string {
  const method = options.method ?? "GET";
  const region = options.region ?? "auto";
  const service = options.service ?? "s3";
  const now = options.now ?? Date.now;

  const url = new URL(options.endpoint);
  const host = url.host;
  const canonicalUri = `/${uriEncode(options.bucket, true)}/${uriEncode(options.key, false)}`;

  const { amzDate, dateStamp } = formatAmzDate(now());
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${options.accessKeyId}/${credentialScope}`;

  // Query parameters that take part in the signature, sorted by
  // key. Values are URI-encoded; the credential's slashes are
  // encoded too (encodeSlash=true) because it lives in a query
  // value.
  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(options.expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params
    .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const key = signingKey(options.secretAccessKey, dateStamp, region, service);
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  return `${url.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// Incremental SHA-256 over a ReadableStream. Never holds more than
// one chunk in memory, so a multi-gigabyte body hashes in constant
// space. Returned lowercase hex. Kept for the future signed-upload
// path; the presigned GET above does not call it.
export async function sha256HexStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}
