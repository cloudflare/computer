// Example Worker + Durable Object that turns a text prompt into an
// image and hands back a shareable link.
//
// One shot: POST /prompt with { "prompt": "..." }. The Durable
// Object runs the prompt through a Workers AI text-to-image model,
// writes the generated PNG into its Workspace, then uploads that
// file to R2 and returns a presigned URL through
// @cloudflare/workspace/assets.
//
// Wire shape:
//
//   client ──► Worker POST /prompt
//                │  (DO RPC call)
//                ▼
//          AssetWorkspace DO ──► env.AI.run(flux)        generate image
//                            ──► Workspace.fs.writeFile  store in the VFS
//                            ──► createAssets(...).share upload + presign
//                │
//                ▼
//          { path, url, expiresAt }
//
// This is a production-only example. The presigner needs R2 S3
// credentials (set as secrets), and the image model runs on
// Cloudflare's network, so `wrangler dev` against a local stack
// won't produce a working link. Deploy it and hit the deployed URL.

import { DurableObject } from "cloudflare:workers";
import { type DurableObjectStorageLike, Workspace } from "@cloudflare/workspace";
import { createAssets } from "@cloudflare/workspace/assets";

// Black Forest Labs FLUX.2 [klein] 9B — a fast text-to-image model.
// Returns the image as a base64 string.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

// How long a shared link stays valid: one hour.
const LINK_TTL_MS = 60 * 60 * 1000;

interface GenerateResult {
  path: string;
  url: string;
}

export class AssetWorkspace extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      // ctx.storage.sql.exec returns a narrower row type than
      // DurableObjectStorageLike declares; the runtime shape
      // matches. Cast through unknown to bypass invariance.
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      // No backend: this workspace only needs its filesystem. The
      // shell half throws if touched, which we never do.
      sessionId: ctx.id.toString(),
    });
  }

  // Generate an image from `prompt`, store it, and return a
  // shareable link.
  async generate(prompt: string): Promise<GenerateResult> {
    const image = await this.#runModel(prompt);

    // One file per request, named by a random id so repeated
    // prompts never collide on the VFS.
    const path = `/workspace/${crypto.randomUUID()}.png`;
    await this.#workspace.fs.mkdir("/workspace", { recursive: true });
    await this.#workspace.fs.writeFile(path, image);

    const assets = createAssets({
      ws: this.#workspace,
      bucket: this.env.ASSETS,
      s3: { bucket: this.env.ASSETS_BUCKET_NAME },
      env: this.env as unknown as Record<string, string | undefined>,
    });

    const url = await assets.share(path, {
      expiresAfter: LINK_TTL_MS,
      prefix: "generated",
    });

    return { path, url };
  }

  // Run the text-to-image model and return the decoded PNG bytes.
  // The model takes multipart form fields and returns the image as
  // a base64 string.
  async #runModel(prompt: string): Promise<Uint8Array> {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", "1024");
    form.append("height", "1024");

    // FormData doesn't expose its serialized body or boundary.
    // Passing it through a Response constructor serializes it and
    // sets the multipart Content-Type with the boundary the model
    // needs to parse the fields.
    const formResponse = new Response(form);
    const body = formResponse.body;
    const contentType = formResponse.headers.get("content-type");
    if (body === null || contentType === null) {
      throw new Error("failed to serialize the model request body");
    }

    // The model's multipart input shape isn't in the generated Ai
    // types yet, so call run() through a minimal typed view of the
    // binding. Keep the call on env.AI: the binding's run() is a
    // method that relies on its own `this`, so a detached reference
    // would throw inside the binding.
    const ai = this.env.AI as unknown as {
      run(
        model: string,
        input: { multipart: { body: ReadableStream; contentType: string } },
      ): Promise<{ image?: string }>;
    };
    const result = await ai.run(IMAGE_MODEL, { multipart: { body, contentType } });

    if (typeof result.image !== "string") {
      throw new Error("image model returned no image");
    }
    return decodeBase64(result.image);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        ["assets example", "", '  POST /prompt   { "prompt": "..." }', ""].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    if (url.pathname === "/prompt") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
      }
      return handlePrompt(request, env);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface PromptRequest {
  prompt?: string;
}

async function handlePrompt(request: Request, env: Env): Promise<Response> {
  let body: PromptRequest;
  try {
    body = (await request.json()) as PromptRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }

  const prompt = body.prompt;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return errorJSON(new Error("must provide a non-empty prompt"), 400);
  }

  // One Durable Object instance owns the workspace. A fixed name
  // keeps every request on the same store; swap in a per-user name
  // to give each caller an isolated workspace.
  const stub = env.AssetWorkspace.get(env.AssetWorkspace.idFromName("default"));
  try {
    const result = await stub.generate(prompt);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Decode a base64 string to bytes. atob is available in the Workers
// runtime; map each character to its byte value.
function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
