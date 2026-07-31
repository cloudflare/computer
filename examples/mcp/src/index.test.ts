import { env, SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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

    const internal = await SELF.fetch("https://example.test/ws");
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
