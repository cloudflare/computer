// Asset key construction and the R2 upload step.
//
// The key shape is:
//
//   ${normalisedPrefix}/${id}/${basename(path)}
//
// - `id` is a fresh Crockford base32 token, so the same VFS file
//   shared twice yields two distinct keys (no overwrite).
// - only basename(path) lands in the key, so the full VFS path is
//   never exposed in the URL.
// - the prefix is normalised: leading and trailing slashes
//   stripped, internal runs of slashes collapsed.

import { randomId } from "./base32.js";
import { contentTypeForPath } from "./mime.js";

// The slice of R2Bucket we touch for uploads. Duck-typed so callers
// can pass the real binding or a test fake without importing
// @cloudflare/workers-types.
export interface R2PutBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

// Strip leading/trailing slashes and collapse internal runs. An
// empty or slash-only prefix normalises to "".
export function normalisePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
}

export function buildKey(path: string, prefix: string | undefined, id: string): string {
  const name = basename(path);
  const normalised = normalisePrefix(prefix);
  return normalised.length > 0 ? `${normalised}/${id}/${name}` : `${id}/${name}`;
}

// RFC 6266 Content-Disposition. The filename is quoted; embedded
// quotes and backslashes are escaped. Non-ASCII filenames also get
// an RFC 5987 filename* form so clients that understand it recover
// the original bytes.
export function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const escaped = filename.replace(/["\\]/g, "\\$&");
  let value = `${disposition}; filename="${escaped}"`;
  if (/[^\x20-\x7e]/.test(filename)) {
    const encoded = encodeURIComponent(filename);
    value += `; filename*=UTF-8''${encoded}`;
  }
  return value;
}

export interface UploadInput {
  bucket: R2PutBucket;
  key: string;
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentDisposition: string;
  customMetadata: Record<string, string>;
}

// Upload one object. The body is a ReadableStream piped straight
// from the VFS, so nothing is buffered here.
export async function putObject(input: UploadInput): Promise<void> {
  await input.bucket.put(input.key, input.body, {
    httpMetadata: {
      contentType: input.contentType,
      contentDisposition: input.contentDisposition,
    },
    customMetadata: input.customMetadata,
  });
}

export { contentTypeForPath, randomId };
