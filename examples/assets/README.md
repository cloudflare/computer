# assets example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Cloudflare Worker + Durable Object that turns a text prompt into
an image and hands back a shareable link. One shot: `POST /prompt`,
get a URL.

The Durable Object runs the prompt through a Workers AI
text-to-image model, writes the generated PNG into its `Workspace`,
then uploads that file to R2 and returns a presigned URL through
[`@cloudflare/workspace/assets`](../../docs/14_assets_interface.md).

> [!NOTE]
> This is a **production-only** example. The presigner needs R2 S3
> credentials, and the image model runs on Cloudflare's network, so
> `wrangler dev` against a local stack won't produce a working link.
> Deploy it and hit the deployed URL.

## Architecture

```
client ─► Worker POST /prompt
            │  (DO RPC call)
            ▼
      AssetWorkspace DO ──► env.AI.run(flux)        generate the image
                        ──► Workspace.fs.writeFile  store it in the VFS
                        ──► createAssets(...).share  upload to R2 + presign
            │
            ▼
      { path, url }
```

1. The Worker accepts `POST /prompt` and forwards the prompt to a
   single `AssetWorkspace` Durable Object.
2. The DO holds a backend-less `Workspace` — it only needs the
   filesystem, not a shell. It runs the prompt through the
   [FLUX.2 \[klein\] 9B](https://developers.cloudflare.com/workers-ai/models/flux-2-klein-9b/)
   model on `env.AI`, which returns the image as base64.
3. The DO decodes the image, writes it to
   `/workspace/<uuid>.png`, then calls `createAssets(...).share`
   to upload the file to R2 and presign a `GET` URL.
4. The response is `{ path, url }`. The link is valid for one hour.

## Configuration

The bucket binding alone can't mint a presigned URL, so the
presigner needs R2 S3 credentials. Create an R2 API token scoped to
the bucket. The credential names are listed in
[`.dev.vars.example`](.dev.vars.example); copy it to `.dev.vars` to
fill them in, then set the same values as secrets for production:

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

The bucket name is supplied to the assets client through the
`ASSETS_BUCKET_NAME` var in `wrangler.jsonc`; keep it in step with
the `bucket_name` on the `ASSETS` binding.

Create the bucket once before the first deploy:

```sh
wrangler r2 bucket create workspace-assets-example
```

## HTTP surface

```
POST /prompt   { "prompt": "..." }
               → { "path": "/workspace/<uuid>.png", "url": "https://..." }
```

## Deploy and run

```sh
npm run deploy --workspace @example/workspace-assets

curl -X POST https://workspace-assets-example.<your-subdomain>.workers.dev/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"a sunset over the alps, oil painting"}'
```

The response carries a `url`; open it to see the generated image.
The link expires after an hour, after which the object stays in the
bucket but the URL stops working. See the
[assets interface](../../docs/14_assets_interface.md) for the
cleanup story.

## Layout

```
examples/assets/
  wrangler.jsonc      Worker + DO + AI + R2 bindings
  .dev.vars.example   R2 S3 credential names; copy to .dev.vars
  src/index.ts        Worker handler + DO (AssetWorkspace)
```
