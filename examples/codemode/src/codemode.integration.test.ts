import { SELF } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("Computer Codemode MCP", () => {
  it("exposes Computer tools through one Codemode code tool", async () => {
    const stream = await SELF.fetch("https://example.test/mcp");
    expect(stream.status).toBe(405);
    expect(stream.headers.get("allow")).toBe("POST");

    client = new Client({ name: "codemode-example-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://example.test/mcp"), {
      fetch: (input, init) => SELF.fetch(input, init),
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["code"]);
    expect(listed.tools[0]?.description).toContain("codemode.read");
    expect(listed.tools[0]?.description).toContain("exec: (input: ExecInput)");

    const result = await client.callTool({
      name: "code",
      arguments: {
        code: `async () => {
          await codemode.write({ path: "/workspace/message.txt", content: "hello" });
          await codemode.edit({
            path: "/workspace/message.txt",
            edits: [{ oldText: "hello", newText: "hello from codemode" }]
          });
          const file = await codemode.read({ path: "/workspace/message.txt" });
          const listing = await codemode.ls({ path: "/workspace" });
          const shell = await codemode.exec({ command: "pwd", backend: "worker-shell" });
          return {
            content: file.content,
            listed: listing.entries.some((entry) => entry.name === "message.txt"),
            cwd: shell.stdout.trim()
          };
        }`,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(readTextResult(result)).toEqual({
      content: "hello from codemode",
      listed: true,
      cwd: "/workspace",
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
    expect(readTextResult(persisted)).toBe("hello from codemode");
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
