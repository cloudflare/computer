# Assets interface

> [!IMPORTANT]
> This document describes the **intended design**. Names,
> signatures, and behaviours described here are targets. When in
> doubt, treat the code as authoritative for what runs and this doc
> as authoritative for what we're moving toward.

The assets module shares a file from the workspace with the outside
world. You give it a path inside the virtual filesystem and it
uploads the bytes to an R2 bucket, then hands back a presigned URL
that anyone can open until it expires.

The shell can produce a chart, a screenshot, or a build artifact;
`share` turns that into a link you can drop into a chat message or a
webhook without exposing the bucket or the rest of the workspace.

## Creating a client

```ts
import { createAssets } from "@cloudflare/workspace/assets";

const assets = createAssets({
  ws,
  bucket: env.ASSETS,
  s3: { bucket: "agent-assets" },
  env,
});
```

To make the worker-backend shell command available, attach the
client when constructing the `Workspace`:

```ts
const ws = new Workspace({
  storage: ctx.storage,
  backends: [new WorkerBackend(/* ... */)],
  assets: (ws) => createAssets({ ws, bucket: env.ASSETS, s3: { bucket: "agent-assets" }, env }),
});
```

`createAssets` binds the workspace and the bucket once and returns a
client. The shape mirrors `createGitClient({ ws })`: bind the
dependencies up front so each `share` call only takes the path and
the options that vary.

Two distinct things named "bucket" are in play. `bucket` is the R2
binding the uploads go through. `s3.bucket` is the bucket's name,
which the binding can't report and the presigner needs to build the
URL.

## Sharing a file

```ts
const url = await assets.share("/workspace/out/chart.png", {
  expiresAfter: 30 * 1000,
  prefix: `/agent-${ws.sessionId}`,
});
```

`share` reads the file, uploads it, and returns a presigned `GET`
URL valid for `expiresAfter` milliseconds.

### Options

| Option | Meaning |
| --- | --- |
| `expiresAfter` | URL lifetime in milliseconds. Required. Rounded up to whole seconds and capped at seven days, the maximum a presigned URL allows. |
| `prefix` | Key prefix in the bucket, for example `agent-<session>`. Slashes are normalized. This is a key prefix, not a path inside the workspace. |
| `contentType` | Override the type inferred from the file extension. |
| `filename` | Override the download filename. Defaults to the basename of the shared path. |
| `disposition` | `inline` (the default) lets a browser render the file; `attachment` forces a download. |

## Object keys

The key written to R2 is:

```
<prefix>/<id>/<basename>
```

`id` is a fresh token for every call: sixteen random bytes encoded
with Crockford base32, about twenty-six characters. Two consequences
fall out of this:

- **Every share is unique.** Sharing the same file twice produces two
  different keys, so a second share never overwrites the first and
  the two URLs stay independent.
- **The path stays private.** Only the basename of the file appears
  in the key. A share of `/workspace/secret/plans/q3.pdf` lands at
  `<prefix>/<id>/q3.pdf` — the directories never leave the workspace.

## Object metadata

Each upload sets:

- `Content-Type`, inferred from the file extension or taken from the
  `contentType` option. Unknown extensions fall back to
  `application/octet-stream`.
- `Content-Disposition`, carrying the filename so a browser names the
  download correctly.
- Custom metadata recording the source path inside the workspace, the
  session id, and the expiry timestamp.

## Configuration

The presigner signs requests for R2's S3-compatible endpoint, so it
needs an account id, an access key id, a secret access key, and the
bucket name. Pass them on the `s3` object, or let the client read
them from the environment you hand it:

| Value | `s3` field | Environment fallback |
| --- | --- | --- |
| Account id | `accountId` | `CLOUDFLARE_ACCOUNT_ID` |
| Access key id | `accessKeyId` | `R2_ACCESS_KEY_ID`, then `AWS_ACCESS_KEY_ID` |
| Secret access key | `secretAccessKey` | `R2_SECRET_ACCESS_KEY`, then `AWS_SECRET_ACCESS_KEY` |
| Endpoint | `endpoint` | `R2_ENDPOINT`, otherwise derived from the account id |

Explicit `s3` fields win over the environment. The bucket name has no
environment fallback and is always required. When a credential can't
be found, `createAssets` throws with a message naming the missing
value rather than failing later as an opaque permission error from
R2.

The R2 binding alone can't mint presigned URLs, which is why the
credentials are needed on top of it. Create an R2 API token scoped to
the bucket and supply its keys through the environment.

## Worker-backend shell command

When a `Workspace` is constructed with an assets client, the worker
backend's just-bash shell exposes:

```sh
assets publish <path> [<expiry>]
```

The command writes the share URL to stdout. `<path>` may be absolute
or relative to the current working directory. `<expiry>` defaults to
one hour; a bare number is milliseconds, and `ms`, `s`, `m`, and `h`
suffixes are accepted.

The command still runs the publish on the host Durable Object. The
Dynamic Worker does not receive the R2 bucket binding or signing
secrets.

## Expiry and cleanup

`expiresAfter` controls how long the URL works, not how long the
object lives. When the signature expires the link stops working, but
the object stays in the bucket. To reclaim the space, set an R2
lifecycle rule on the bucket, or sweep objects using the expiry
timestamp recorded in their custom metadata. Automatic cleanup is not
part of this module today.
