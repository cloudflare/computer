import { env, SELF } from "cloudflare:test";
import type { CodemodeRPC } from "@cloudflare/computer-rpc";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newWebSocketRpcSession } from "capnweb";
import { afterEach, describe, expect, it } from "vitest";

let client: Client | undefined;

const authorizedFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer test-token");
  return SELF.fetch(input, { ...init, headers });
};

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("Computer Code Mode MCP", () => {
  it("serves public setup routes and keeps the container callback private", async () => {
    const home = await SELF.fetch("https://example.test/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("https://example.test/mcp");

    const health = await SELF.fetch("https://example.test/health");
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const internal = await SELF.fetch("https://example.test/api");
    expect(internal.status).toBe(404);
  });

  it("requires the configured bearer token", async () => {
    const missing = await SELF.fetch("https://example.test/mcp", { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe("Bearer");

    const wrong = await SELF.fetch("https://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer test-tokem" },
    });
    expect(wrong.status).toBe(401);

    const get = await authorizedFetch("https://example.test/mcp");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const { COMPUTER_MCP } = env as unknown as {
      COMPUTER_MCP: DurableObjectNamespace;
    };
    const id = COMPUTER_MCP.idFromName("direct-auth-test");
    const direct = await COMPUTER_MCP.get(id).fetch("https://example.test/mcp", {
      method: "POST",
    });
    expect(direct.status).toBe(401);
  });

  it("exposes durable Computer tools through one Code Mode tool", async () => {
    client = new Client({ name: "computer-mcp-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://example.test/mcp"), {
      fetch: authorizedFetch,
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["code"]);
    const description = listed.tools[0]?.description;
    expect(description).toContain("codemode.read");
    expect(description).toContain('"worker-shell"');
    expect(description).toContain("no ambient outbound network");
    expect(description).toContain("HTTPS URLs");
    expect(description).toContain("Cannot run npm");
    expect(description).toContain('"container-shell"');
    expect(description).toContain("Full Debian Linux");
    expect(description).toContain("Cold starts more slowly");

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          await codemode.write({ path: "/workspace/message.txt", content: "hello" });
          await codemode.edit({
            path: "/workspace/message.txt",
            edits: [{ oldText: "hello", newText: "hello from Code Mode" }]
          });
          const file = await codemode.read({ path: "/workspace/message.txt" });
          const listing = await codemode.ls({ path: "/workspace" });
          const shell = await codemode.exec({ command: "pwd" });
          const git = await codemode.exec({ command: "git init && git status --short" });
          return {
            content: file.content,
            listed: listing.entries.some((entry) => entry.name === "message.txt"),
            backend: shell.backend,
            cwd: shell.stdout.trim(),
            gitWorked: git.exitCode === 0 && git.stdout.includes("message.txt")
          };
        }`,
      },
    });

    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(readTextResult(result)).toEqual({
      content: "hello from Code Mode",
      listed: true,
      backend: "worker-shell",
      cwd: "/workspace",
      gitWorked: true,
    });

    const persisted = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const file = await codemode.read({ path: "/workspace/message.txt" });
          return file.content;
        }`,
      },
    });
    expect(readTextResult(persisted)).toBe("hello from Code Mode");

    const outbound = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          const response = await fetch("https://example.com");
          return response.status;
        }`,
      },
    });
    expect(outbound.isError).toBe(true);
  });
});

describe("codemode from inside the container", () => {
  // The public Worker never forwards /codemode; the container reaches
  // it through the egress interception, which lands on the Durable
  // Object's fetch. The test takes the same door directly.
  function durableObject(name: string) {
    const { COMPUTER_MCP } = env as unknown as { COMPUTER_MCP: DurableObjectNamespace };
    return COMPUTER_MCP.get(COMPUTER_MCP.idFromName(name));
  }

  async function connect(name: string) {
    const response = await durableObject(name).fetch("https://example.test/codemode", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("expected a websocket");
    socket.accept();
    return newWebSocketRpcSession<CodemodeRPC>(socket as unknown as WebSocket);
  }

  it("stays private and insists on a websocket", async () => {
    const publicRoute = await SELF.fetch("https://example.test/codemode");
    expect(publicRoute.status).toBe(404);
    const plain = await durableObject("codemode-plain").fetch("https://example.test/codemode");
    expect(plain.status).toBe(400);
  });

  it("describes the notes connector and runs scripts against it", async () => {
    using api = await connect("codemode-run");

    const description = await api.describe();
    expect(description.connectors).toEqual(["notes"]);
    expect(description.types).toContain("declare const notes:");
    expect(description.types).toContain("add: (input: AddInput) => Promise<AddOutput>;");

    const added = await api.execute({
      code: 'await notes.add({ text: "hello" }); console.log("added"); return await notes.list({});',
    });
    expect(added).toMatchObject({ status: "completed", result: ["hello"], logs: ["added"] });

    const failed = await api.execute({ code: 'throw new Error("nope");' });
    expect(failed).toMatchObject({ status: "error" });
    expect(failed.status === "error" && failed.error).toContain("nope");

    const blocked = await api.execute({
      code: 'return await fetch("https://example.com").then((r) => r.status);',
    });
    expect(blocked.status).toBe("error");
  });
});

function readTextResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((item) => item.type === "text");
  if (!text?.text) throw new Error("Expected a text MCP result.");
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return text.text;
  }
}
