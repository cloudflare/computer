// Public surface of @cloudflare/workspace/assets.
//
// `createAssets({ ws, bucket, s3 })` binds a workspace and an R2
// bucket once and returns a client whose `share(path, opts)`
// uploads a VFS file to R2 and returns a time-limited presigned
// GET URL.
//
//   import { createAssets } from "@cloudflare/workspace/assets";
//
//   const assets = createAssets({ ws, bucket: env.ASSETS, s3: { bucket: "agent-assets" } });
//   const url = await assets.share("/workspace/out/image.png", {
//     expiresAfter: 30_000,
//     prefix: `/agent-${ws.sessionId}`,
//   });
//
// Uploads go through the R2 binding (`bucket.put`); the returned
// URL is signed for R2's S3-compatible endpoint. R2 requires a
// known-length stream, so the VFS stream is piped through a
// FixedLengthStream sized from `fs.stat(path)`. The presigned GET
// uses UNSIGNED-PAYLOAD, so the file body is read exactly once —
// streamed from the VFS into `put` — and never buffered.

import { presignUrl } from "./sigv4.js";
import {
  basename,
  buildKey,
  contentDisposition,
  contentTypeForPath,
  putObject,
  type R2PutBucket,
  randomId,
} from "./upload.js";

// Maximum presigned-URL lifetime AWS / R2 accept: 7 days.
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

// Duck-typed workspace handle. Only the slice the assets module
// needs: size lookup, a streaming reader, and the session id used
// to tag objects.
export interface WorkspaceLike {
  readonly sessionId: string;
  readonly fs: {
    stat(path: string): Promise<{ size: number }>;
    readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  };
}

// Environment record the S3 credential defaults are derived from.
// In a Worker this is the `env` binding object; the values are
// plain strings.
export type AssetsEnv = Record<string, string | undefined>;

export interface S3Config {
  // R2 bucket name. The binding can't surface it and there's no
  // conventional env var, so it stays required.
  bucket: string;
  // Cloudflare account id. Defaults to env.CLOUDFLARE_ACCOUNT_ID
  // and also fixes the default endpoint.
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  // S3 endpoint origin. Defaults to
  // https://<accountId>.r2.cloudflarestorage.com.
  endpoint?: string;
  // SigV4 region / service. R2 ignores the region; defaults match
  // the documented values.
  region?: string;
  service?: string;
}

export interface CreateAssetsOptions {
  ws: WorkspaceLike;
  // R2 binding used for uploads.
  bucket: R2PutBucket;
  s3: S3Config;
  // Source for credential / account defaults. Optional; pass the
  // Worker `env` so the standard R2 / Cloudflare vars are picked up.
  env?: AssetsEnv;
  // Injectable clock for deterministic tests. Defaults to Date.now.
  now?: () => number;
}

export interface ShareOptions {
  // URL lifetime in milliseconds. Required. Mapped to
  // X-Amz-Expires (seconds, rounded up). Capped at 7 days.
  expiresAfter: number;
  // R2 key prefix, e.g. `/agent-${sessionId}`. Slashes are
  // normalised; this is a key prefix, not a VFS path.
  prefix?: string;
  // Override the inferred Content-Type.
  contentType?: string;
  // Override the Content-Disposition filename. Defaults to the
  // shared file's basename.
  filename?: string;
  // inline (default) lets a browser render the asset; attachment
  // forces a download.
  disposition?: "inline" | "attachment";
}

export interface AssetsClient {
  // Upload `path` from the VFS to R2 and return a presigned GET URL
  // valid for `opts.expiresAfter` milliseconds.
  share(path: string, opts: ShareOptions): Promise<string>;
}

interface ResolvedS3 {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  for (const v of values) if (v !== undefined && v.length > 0) return v;
  return undefined;
}

// Resolve the S3 config, filling gaps from the environment. Throws
// a clear error if a credential can't be found, since a missing
// secret only fails later as an opaque 403 from R2.
export function resolveS3(s3: S3Config, env: AssetsEnv): ResolvedS3 {
  const accountId = firstDefined(s3.accountId, env.CLOUDFLARE_ACCOUNT_ID);
  const accessKeyId = firstDefined(s3.accessKeyId, env.R2_ACCESS_KEY_ID, env.AWS_ACCESS_KEY_ID);
  const secretAccessKey = firstDefined(
    s3.secretAccessKey,
    env.R2_SECRET_ACCESS_KEY,
    env.AWS_SECRET_ACCESS_KEY,
  );
  const endpoint = firstDefined(
    s3.endpoint,
    env.R2_ENDPOINT,
    accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined,
  );

  if (!accessKeyId) {
    throw new Error(
      "createAssets: missing access key id. Set s3.accessKeyId or the " +
        "R2_ACCESS_KEY_ID / AWS_ACCESS_KEY_ID env var.",
    );
  }
  if (!secretAccessKey) {
    throw new Error(
      "createAssets: missing secret access key. Set s3.secretAccessKey or " +
        "the R2_SECRET_ACCESS_KEY / AWS_SECRET_ACCESS_KEY env var.",
    );
  }
  if (!endpoint) {
    throw new Error(
      "createAssets: missing endpoint. Set s3.endpoint, s3.accountId, the " +
        "R2_ENDPOINT env var, or CLOUDFLARE_ACCOUNT_ID.",
    );
  }

  return {
    bucket: s3.bucket,
    endpoint,
    accessKeyId,
    secretAccessKey,
    region: s3.region ?? "auto",
    service: s3.service ?? "s3",
  };
}

interface FixedLengthBody {
  readable: ReadableStream<Uint8Array>;
  pipeDone: Promise<void>;
  abort(reason: unknown): void;
}

function fixedLengthBody(source: ReadableStream<Uint8Array>, size: number): FixedLengthBody {
  if (typeof FixedLengthStream === "undefined") {
    throw new Error(
      "share: FixedLengthStream is not available. Run this code in the Cloudflare Workers runtime.",
    );
  }

  const fixed = new FixedLengthStream(size);
  const abort = new AbortController();
  const pipeDone = source.pipeTo(fixed.writable, { signal: abort.signal });
  return {
    readable: fixed.readable,
    pipeDone,
    abort(reason: unknown) {
      abort.abort(reason);
    },
  };
}

export function createAssets(options: CreateAssetsOptions): AssetsClient {
  const { ws, bucket } = options;
  const now = options.now ?? Date.now;
  const s3 = resolveS3(options.s3, options.env ?? {});

  return {
    async share(path: string, opts: ShareOptions): Promise<string> {
      if (!(opts.expiresAfter > 0)) {
        throw new Error("share: expiresAfter must be a positive number of milliseconds");
      }
      const expiresIn = Math.min(Math.ceil(opts.expiresAfter / 1000), MAX_EXPIRES_SECONDS);

      const name = basename(path);
      const key = buildKey(path, opts.prefix, randomId());
      const contentType = opts.contentType ?? contentTypeForPath(path);
      const disposition = contentDisposition(opts.disposition ?? "inline", opts.filename ?? name);

      const [{ size }, source] = await Promise.all([ws.fs.stat(path), ws.fs.readFile(path)]);
      const body = fixedLengthBody(source, size);
      try {
        await putObject({
          bucket,
          key,
          body: body.readable,
          contentType,
          contentDisposition: disposition,
          customMetadata: {
            sourcePath: path,
            sessionId: ws.sessionId,
            expiresAt: new Date(now() + expiresIn * 1000).toISOString(),
          },
        });
        await body.pipeDone;
      } catch (error) {
        body.abort(error);
        await body.pipeDone.catch(() => undefined);
        throw error;
      }

      return presignUrl({
        endpoint: s3.endpoint,
        bucket: s3.bucket,
        key,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        expiresIn,
        region: s3.region,
        service: s3.service,
        now,
      });
    },
  };
}

export type { R2PutBucket } from "./upload.js";
