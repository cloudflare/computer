// Hand-written env shape for the platform Worker. Run
// `wrangler types` to regenerate from wrangler.jsonc when the
// bindings change.

interface Env {
  AssetWorkspace: DurableObjectNamespace<import("./src/index.js").AssetWorkspace>;
  AI: Ai;
  ASSETS: R2Bucket;
  ASSETS_BUCKET_NAME: string;

  // R2 S3 credentials for presigning, set as secrets:
  //   wrangler secret put R2_ACCESS_KEY_ID
  //   wrangler secret put R2_SECRET_ACCESS_KEY
  //   wrangler secret put CLOUDFLARE_ACCOUNT_ID
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}
