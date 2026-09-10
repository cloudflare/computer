// A small connector so `codemode` has something to call from inside the
// container. It keeps a list of notes in the Durable Object's storage.
// Replace it with connectors over whatever the workspace should reach:
// KV, R2, an MCP server through McpConnector, an OpenAPI service.

import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";

const KEY = "codemode:notes";

export class NotesConnector extends CodemodeConnector<unknown> {
  readonly #storage: DurableObjectStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.#storage = ctx.storage;
  }

  name() {
    return "notes";
  }

  protected instructions() {
    return "A scratch list of notes kept on the host, shared by every script.";
  }

  protected tools(): ConnectorTools {
    return {
      add: {
        description: "Append a note and return the new count.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "The note" } },
          required: ["text"],
        },
        execute: async (args) => {
          const { text } = args as { text: string };
          const notes = await this.#list();
          notes.push(text);
          await this.#storage.put(KEY, notes);
          return { count: notes.length };
        },
      },
      list: {
        description: "All notes, oldest first.",
        inputSchema: { type: "object", properties: {} },
        execute: () => this.#list(),
      },
      clear: {
        description: "Delete every note.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          await this.#storage.delete(KEY);
          return { ok: true };
        },
      },
    };
  }

  async #list(): Promise<string[]> {
    return (await this.#storage.get<string[]>(KEY)) ?? [];
  }
}
