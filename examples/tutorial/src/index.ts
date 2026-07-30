// Recipe card tutorial. POST /prompt {"prompt":"spaghetti bolognese"}
// and the agent finds a recipe on openstove.org, writes a markdown
// card into the workspace, converts it to a PDF with pandoc inside the
// container, and answers with a link to the PDF.
//
//   POST /prompt ──► RecipeAgent (Think + Computer)
//                      │ fetch_url openstove.org           (host)
//                      │ write     /workspace/card.md      (host)
//                      │ bash      pandoc card.md -o card.pdf (container)
//                      ▼
//                    R2 ──► signed link, good for a day
//
// The write and the pandoc run touch one filesystem: the host writes
// through the Workspace, the container sees the same bytes on its
// FUSE mount, and the PDF the container produces is readable back on
// the host once the shell command finishes.
//
// README.md walks through building this file from an empty directory.

import { Think } from "@cloudflare/think";
import {
  createComputerWorkspace,
  type LocalComputerWorkspace,
} from "@cloudflare/think/experimental/computer";
import { type DurableObjectStorageLike, WorkspaceProxy } from "@cloudflare/workspace";
import { createAssets } from "@cloudflare/workspace/assets";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/workspace/backends/container";
import { getAgentByName } from "agents";

// Carries container egress back to the durable object. The runtime
// binds it by name, so it has to appear in the worker's module graph.
export { WorkspaceProxy };

const MARKDOWN = "/workspace/card.md";
const PDF = "/workspace/card.pdf";

// The only host the agent is allowed to fetch.
const RECIPES = "openstove.org";
const SITEMAP = `https://${RECIPES}/sitemap-0.xml`;

// How long a shared link stays valid: one day.
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

const SYSTEM = [
  "You turn a cooking request into a one-page PDF recipe card.",
  "",
  `1. Find the recipe. \`fetch_url\` ${SITEMAP} lists every recipe page.`,
  "   Pick the closest match and fetch it; each page carries the whole",
  '   recipe in a <script type="application/ld+json"> block, so read that',
  "   JSON rather than the surrounding markup.",
  `2. \`write\` the card to ${MARKDOWN}. Use a level-one heading for the`,
  "   dish, a line with the total time and servings, an Ingredients list,",
  "   and numbered Method steps. End with the source page URL spelled out,",
  "   not a markdown link: the card gets printed, and a link prints as its",
  "   text alone.",
  `3. Convert it with \`bash\`: \`pandoc ${MARKDOWN} -o ${PDF} --pdf-engine=typst\`.`,
  "4. Reply with one sentence naming the recipe you picked.",
].join("\n");

class RecipeBase extends Think<Env> {}

export class RecipeAgent extends withWorkspaceContainer(RecipeBase) {
  override maxSteps = 10;
  override fetchTools = {
    allowlist: [`https://${RECIPES}/**`],
    followRedirects: "none" as const,
    maxModelChars: 64_000,
  };
  override workspace: LocalComputerWorkspace;

  readonly #backend: CloudflareContainerBackend;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#backend = new CloudflareContainerBackend({
      container: () => this,
      workspace: { binding: "RecipeAgent", id: ctx.id.toString() },
    });
    this.workspace = createComputerWorkspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [this.#backend],
    });
  }

  override getModel() {
    return "@cf/moonshotai/kimi-k2.6";
  }

  override getSystemPrompt() {
    return SYSTEM;
  }

  // The container dials back in over this route to open its session.
  override async fetch(request: Request): Promise<Response> {
    return new URL(request.url).pathname === "/ws"
      ? this.#backend.handleFetch(request)
      : super.fetch(request);
  }

  /** Run one turn, then publish the PDF the agent left behind. */
  async card(prompt: string): Promise<{ url: string; summary: string }> {
    try {
      await this.workspace.fs.mkdir("/workspace", { recursive: true });
      const turn = await this.saveMessages([
        { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: prompt }] },
      ]);
      if (turn.status !== "completed") {
        throw new Error(`Agent turn ${turn.status}: ${turn.error ?? "no detail"}`);
      }
      const written = await this.workspace.fs.stat(PDF).catch(() => null);
      if (!written?.isFile) throw new Error(`The agent produced no PDF at ${PDF}`);
      // The assets client streams the file from the workspace into R2 and
      // signs a GET for it, so the bucket stays private and the worker
      // never serves the bytes itself. The R2 binding can't sign, hence
      // the S3 credentials from .env.example.
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
      const url = await assets.share(PDF, { expiresAfter: LINK_TTL_MS, prefix: "cards" });
      return { url, summary: lastAssistantText(this.messages) };
    } finally {
      await this.workspace.close();
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/prompt") {
      const { prompt } = (await request.json()) as { prompt?: string };
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return Response.json({ error: "prompt must be a non-empty string" }, { status: 400 });
      }
      // A fresh durable object per request, so every card starts from
      // an empty workspace and an empty conversation.
      const agent = await getAgentByName<Env, RecipeAgent>(env.RecipeAgent, crypto.randomUUID());
      return Response.json(await agent.card(prompt));
    }

    return new Response('recipe card example\n\nPOST /prompt {"prompt":"chili con carne"}\n', {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;

function lastAssistantText(messages: RecipeAgent["messages"]): string {
  const parts = messages.filter((message) => message.role === "assistant").at(-1)?.parts ?? [];
  return parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
}
