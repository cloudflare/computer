# Tutorial: a PDF recipe card agent

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

A worker with one endpoint. You post a dish, an agent finds a matching
recipe on [openstove.org](https://openstove.org/recipes), writes a
markdown recipe card, converts it to a PDF with `pandoc`, and answers
with a link to the PDF.

```
POST /prompt ──► RecipeAgent
                   │ fetch_url https://openstove.org/...      (host)
                   │ write     /workspace/card.md             (host)
                   │ bash      pandoc card.md -o card.pdf     (container)
                   ▼
                 R2 ──► signed link, good for a day
```

Both halves of that pipeline touch one filesystem, which is the point
of the workspace. The `write` tool runs on the host, in the durable
object, and writes through the `Workspace` into durable object storage.
The container sees the same file on its FUSE mount at `/workspace`, so
`pandoc` reads it as an ordinary file. The PDF `pandoc` writes syncs
back the other way when the `bash` call finishes, so the finished file
can be published straight from the workspace.

The finished code is [one file](src/index.ts). The rest of this page
builds it from an empty directory.

## 1. Create the worker project

```sh
npm create cloudflare@latest -- computer-tutorial --type=hello-world \
  --lang=ts --no-git --no-deploy -y
cd computer-tutorial
```

Replace the generated `wrangler.jsonc` with the bindings this project
needs: Workers AI for the model, a durable object with a container
attached to it, and an R2 bucket for the finished PDFs.

```jsonc
{
  "name": "computer-tutorial",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-26",
  "compatibility_flags": ["nodejs_compat"],

  "ai": { "binding": "AI" },

  "containers": [
    { "class_name": "RecipeAgent", "image": "./Dockerfile", "max_instances": 5 }
  ],

  "durable_objects": {
    "bindings": [{ "name": "RecipeAgent", "class_name": "RecipeAgent" }]
  },

  "r2_buckets": [{ "binding": "CARDS", "bucket_name": "recipe-cards" }],
  "vars": { "CARDS_BUCKET_NAME": "recipe-cards" },

  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RecipeAgent"] }]
}
```

Two details matter here. The `containers` entry names the same class as
the durable object binding — one container instance per durable object,
which is how the agent gets a private Linux box. And the workspace
keeps its files in SQLite-backed durable object storage, so the class
has to be in `new_sqlite_classes`.

Create the bucket now; `wrangler` won't do it for you:

```sh
wrangler r2 bucket create recipe-cards
```

## 2. Install the dependencies

```sh
npm install @cloudflare/computer @cloudflare/think agents ai zod
```

- `@cloudflare/computer` is the filesystem, the container backend, and
  the assets client that publishes to R2.
- `@cloudflare/think` provides the agent loop and its file, shell, and
  fetch tools. `agents` provides `getAgentByName` for reaching an
  instance by name; `ai` and `zod` satisfy Think's peer dependencies.

## 3. Create the Dockerfile

The container is an ordinary Linux image with one requirement: `computerd`,
the workspace daemon, has to be PID 1. It mounts the workspace at
`MOUNT_POINT` and syncs it with the durable object. Everything else in
the image is yours — here, `pandoc` and a PDF engine for it.

```dockerfile
FROM ghcr.io/cloudflare/computer-computerd-linux-x64:VERSION AS computerd

FROM debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates curl xz-utils \
 && ...install pandoc and typst...

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
```

See [`Dockerfile`](Dockerfile) for the full version, including the
pinned `pandoc` and `typst` downloads. `typst` is the PDF engine
because it is a single 30 MB binary; a LaTeX install would cost several
hundred megabytes of image.

`FUSE_MOUNT=auto` uses the kernel FUSE backend when `/dev/fuse` is
reachable, which it is on Cloudflare Containers, and falls back to a
userspace shim otherwise, which is what `wrangler dev` gets. One image
works in both places.

## 4. Give Think a Computer workspace

The durable object owns a `CloudflareContainerBackend`, which is the
container the workspace is mounted in. The `Workspace` instance enables
Computer's Think-compatible methods so Think's built-in tools use the
same filesystem as the container.

```ts
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { Think } from "@cloudflare/think";
import {
  type DurableObjectStorageLike,
  type ThinkWorkspaceCompatibility,
  Workspace,
} from "@cloudflare/computer";

class RecipeBase extends Think<Env> {}

export class RecipeAgent extends withWorkspaceContainer(RecipeBase) {
  readonly #backend = new CloudflareContainerBackend({
    container: () => this,
    workspace: { binding: "RecipeAgent", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
  });

  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [this.#backend],
    useThink: true,
  }) as Workspace & ThinkWorkspaceCompatibility;

  override async fetch(request: Request): Promise<Response> {
    return new URL(request.url).pathname === "/ws"
      ? this.#backend.handleFetch(request)
      : super.fetch(request);
  }
}
```

The explicit `direct` policy preserves the example's outbound Internet
access. Use `{ mode: "none" }` when commands in the container do not need
network access.

`withWorkspaceContainer` mixes the container lifecycle into Think, so
the durable object can start and stop its own container. The
`workspace: { binding, id }` pair is how the container finds its way
home: it dials the named binding at that id, which is why `fetch` has to
hand `/ws` to the backend before the base class sees it.

## 5. Hook the workspace up to the agent

Think already has file and shell tools. The Computer workspace makes
those tools use the same filesystem as the container:
`write` calls Computer's host-side filesystem, while `bash` calls the
container shell. Think's fetch tool gets an allowlist of one host, so
the agent can read openstove.org and nothing else.

```ts
override maxSteps = 10;
override fetchTools = {
  allowlist: ["https://openstove.org/**"],
  followRedirects: "none" as const,
  maxModelChars: 64_000,
};

override getModel() {
  return "@cf/zai-org/glm-5.2";
}

override getSystemPrompt() {
  return [
    "You turn a cooking request into a one-page PDF recipe card.",
    "",
    "1. Find the recipe. `fetch_url` https://openstove.org/sitemap-0.xml lists every recipe page.",
    "   Pick the closest match and fetch it; each page carries the whole",
    '   recipe in a <script type="application/ld+json"> block, so read that',
    "   JSON rather than the surrounding markup.",
    "2. `write` the card to /workspace/card.md. Use a level-one heading for the",
    "   dish, a line with the total time and servings, an Ingredients list,",
    "   and numbered Method steps. End with the source page URL spelled out,",
    "   not a markdown link: the card gets printed, and a link prints as its",
    "   text alone.",
    "3. Convert it with `bash`: `pandoc /workspace/card.md -o /workspace/card.pdf --pdf-engine=typst`.",
    "4. Reply with one sentence naming the recipe you picked.",
  ].join("\n");
}
```

Nothing copies files between `write` and `bash`: the write goes into
durable object storage and the container reads it back out of the mount,
and the PDF `pandoc` leaves behind travels the same road in reverse.

The system prompt is what turns those three tools into a recipe card:
fetch the sitemap, pick the closest page, read the JSON-LD the page
carries, write the card, and run `pandoc`.

One method drives a whole turn and publishes the result.
`saveMessages` appends the user's message, runs the turn, and reports
how it ended, so `card` can wait for the agent to finish and then hand
the PDF to the assets client:

```ts
async card(prompt: string): Promise<{ url: string; summary: string }> {
  try {
    await this.workspace.fs.mkdir("/workspace", { recursive: true });
    const turn = await this.saveMessages([
      { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: prompt }] },
    ]);
    if (turn.status !== "completed") {
      throw new Error(`Agent turn ${turn.status}: ${turn.error ?? "no detail"}`);
    }
    const assets = createAssets({
      ws: this.workspace,
      bucket: this.env.CARDS,
      s3: {
        bucket: this.env.CARDS_BUCKET_NAME,
        accountId: this.env.CLOUDFLARE_ACCOUNT_ID,
        accessKeyId: this.env.R2_ACCESS_KEY_ID,
        secretAccessKey: this.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const url = await assets.share("/workspace/card.pdf", {
      expiresAfter: 24 * 60 * 60 * 1000,
      prefix: "cards",
    });
    return { url, summary: lastAssistantText(this.messages) };
  } finally {
    await this.workspace.close();
  }
}
```

`share` streams the file out of the workspace into R2 and signs a GET
for it, so the bucket stays private, the worker never serves the bytes,
and the link stops working after a day. The `finally` block closes the
container session after this one-shot agent has finished.
[`examples/assets`](../assets) uses the same client on its own.

## 6. Add the export

The worker itself is the small part: one route, and a durable object
instance per request so every card starts from an empty workspace and
an empty conversation.

```ts
export { WorkspaceProxy };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/prompt") {
      const { prompt } = (await request.json()) as { prompt?: string };
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return Response.json({ error: "prompt must be a non-empty string" }, { status: 400 });
      }
      const agent = await getAgentByName<Env, RecipeAgent>(env.RecipeAgent, crypto.randomUUID());
      return Response.json(await agent.card(prompt));
    }

    return new Response('POST /prompt {"prompt":"chili con carne"}\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

Three exports have to be reachable from the entrypoint: the default
handler, the `RecipeAgent` class the durable object binding names, and
`WorkspaceProxy`, which carries the container's egress back to the
durable object. `WorkspaceProxy` is re-exported from
`@cloudflare/computer`; the runtime binds it by name, so it has to
appear in the module graph even though your code never calls it.

## Running it

You need Docker running locally. The first build pulls the `computerd` image
from the public GitHub Container Registry and installs `pandoc` and
`typst` on top of a slim debian.

Presigning needs R2 S3 credentials the binding can't provide. Create an
R2 API token scoped to the bucket, then copy
[`.env.example`](.env.example) to `.env` and fill it in. In production
set the same names as secrets:

```sh
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

`R2_ENDPOINT` can be set instead of `CLOUDFLARE_ACCOUNT_ID` when the
endpoint isn't the default `https://<account>.r2.cloudflarestorage.com`.

`worker-configuration.d.ts` is generated from both the bindings and the
credential names, so generate it with the env file:

```sh
npm run build:types
```

From this repository's root, install the dependencies, build the
Computer package, and run the tutorial:

```sh
npm install
npm run build --workspace @cloudflare/computer
npm run dev --workspace @example/computer-tutorial
```

Then ask for a card:

```sh
curl -X POST http://localhost:8787/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"spagetti boglonese"}'
```

```json
{
  "summary": "I have selected the recipe for \"Italian Bolognese Sauce with Thyme.\"",
  "url": "https://<account>.r2.cloudflarestorage.com/recipe-cards/cards/...?X-Amz-Signature=..."
}
```

The first request may be slow: the container has to boot before the
first `bash` runs. The link points at R2 rather than at the worker, so
it works the same whether the worker runs locally or deployed.

`wrangler deploy` works against any account with Workers AI and
Cloudflare Containers enabled.
