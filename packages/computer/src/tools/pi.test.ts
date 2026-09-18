import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";
import { Workspace } from "../workspace.js";
import { createPiTools } from "./pi.js";

function makeWorkspace(): Workspace {
  return new Workspace({ storage: new SQLiteTestStorage(), now: () => 1_700_000_000_000 });
}

function declaration(tools: ReturnType<typeof createPiTools>, name: string) {
  const tool = tools.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no ${name} tool`);
  return tool;
}

describe("createPiTools declarations", () => {
  it("declares the default tool set with object parameter schemas", () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "delete",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
    for (const tool of tools.tools) {
      expect(tool.parameters.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("omits mutating tools when readonly", () => {
    const tools = createPiTools({ workspace: makeWorkspace(), readonly: true });

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
  });

  it("adds exec with a backend enum when shell options are supplied", () => {
    const tools = createPiTools({
      workspace: makeWorkspace(),
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: { description: "Fast worker shell." },
          container: { description: "Full Linux container." },
        },
      },
    });

    const exec = declaration(tools, "exec");
    expect(exec.description).toContain("Fast worker shell.");
    expect(exec.description).toContain("Full Linux container.");
    const backend = exec.parameters.properties?.backend as { enum?: string[] };
    expect(backend.enum).toEqual(["shell", "container"]);
  });

  it("emits required fields without a $schema key and keeps defaults optional", () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    const write = declaration(tools, "write");
    expect(write.parameters.$schema).toBeUndefined();
    expect(write.parameters.required?.sort()).toEqual(["content", "path"]);

    // `find.path` carries a Zod default, so the model may omit it.
    const find = declaration(tools, "find");
    expect(find.parameters.required).toEqual(["pattern"]);
    const path = find.parameters.properties?.path as { default?: string } | undefined;
    expect(path?.default).toBe("/workspace");
  });
});

describe("createPiTools constrained sampling", () => {
  it("requests provider-side strict schemas for the fussy tools only", () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    // `edit` and `write` carry long verbatim strings a model can mangle.
    expect(declaration(tools, "edit").constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
    expect(declaration(tools, "write").constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
    // A plain listing has nothing worth constraining.
    expect(declaration(tools, "ls").constrainedSampling).toBeUndefined();
  });

  it("closes a strict schema and makes optional fields nullable", () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    const read = declaration(tools, "read");
    expect(read.parameters.additionalProperties).toBe(false);
    // Strict mode requires every property; optional ones accept null.
    expect(read.parameters.required?.sort()).toEqual(["byteOffset", "limit", "offset", "path"]);
    const offset = read.parameters.properties?.offset as { type?: unknown };
    expect(offset.type).toEqual(["integer", "null"]);
    const path = read.parameters.properties?.path as { type?: unknown };
    expect(path.type).toBe("string");
  });

  it("escalates to require or opts out when asked", () => {
    const required = createPiTools({
      workspace: makeWorkspace(),
      constrainedSampling: "require",
    });
    expect(declaration(required, "edit").constrainedSampling).toEqual({
      type: "json_schema",
      strict: "require",
    });

    const off = createPiTools({ workspace: makeWorkspace(), constrainedSampling: false });
    expect(declaration(off, "edit").constrainedSampling).toBeUndefined();
    // Opting out also restores the open, minimally-required schema.
    expect(declaration(off, "edit").parameters.additionalProperties).toBeUndefined();
    expect(declaration(off, "read").parameters.required).toEqual(["path"]);
  });

  it("accepts a strict-mode call that fills optional fields with null", async () => {
    const workspace = makeWorkspace();
    const tools = createPiTools({ workspace });

    await tools.execute({
      id: "1",
      name: "write",
      arguments: { path: "/w/a.txt", content: "hi\n" },
    });
    // A provider enforcing the closed schema sends every property.
    const result = await tools.execute({
      id: "2",
      name: "read",
      arguments: { path: "/w/a.txt", offset: null, byteOffset: null, limit: null },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("createPiTools execution", () => {
  it("runs a tool call and returns text content for a complete read", async () => {
    const workspace = makeWorkspace();
    const tools = createPiTools({ workspace });

    await tools.execute({
      id: "1",
      name: "write",
      arguments: { path: "/w/a.txt", content: "hi\n" },
    });
    const result = await tools.execute({ id: "2", name: "read", arguments: { path: "/w/a.txt" } });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns structured results as JSON text", async () => {
    const workspace = makeWorkspace();
    const tools = createPiTools({ workspace });

    await tools.execute({ id: "1", name: "write", arguments: { path: "/w/a.txt", content: "x" } });
    const result = await tools.execute({ id: "2", name: "ls", arguments: { path: "/w" } });

    expect(result.isError).toBe(false);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.count).toBe(1);
    expect(parsed.entries[0].name).toBe("a.txt");
  });

  it("marks a missing file as an error result", async () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    const result = await tools.execute({
      id: "1",
      name: "read",
      arguments: { path: "/w/missing.txt" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("missing.txt");
  });

  it("rejects invalid arguments as a retryable error rather than throwing", async () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    const result = await tools.execute({ id: "1", name: "read", arguments: { path: 42 } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Invalid arguments for read");
  });

  it("reports an unknown tool name with the available names", async () => {
    const tools = createPiTools({ workspace: makeWorkspace() });

    const result = await tools.execute({ id: "1", name: "nope", arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Unknown tool "nope"');
  });

  it("applies a schema default when the model omits the field", async () => {
    const workspace = makeWorkspace();
    const tools = createPiTools({ workspace });

    await tools.execute({
      id: "1",
      name: "write",
      arguments: { path: "/workspace/found.ts", content: "export {};" },
    });
    const result = await tools.execute({
      id: "2",
      name: "find",
      arguments: { pattern: "**/*.ts" },
    });

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.path).toBe("/workspace");
    expect(parsed.entries.map((entry: { path: string }) => entry.path)).toContain(
      "/workspace/found.ts",
    );
  });

  it("returns an image read as a base64 image block", async () => {
    const workspace = makeWorkspace();
    const tools = createPiTools({ workspace });
    // A one-pixel PNG, written through the filesystem so the read tool
    // classifies it by extension and captures its bytes.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    await workspace.fs.mkdir("/workspace", { recursive: true });
    await workspace.fs.writeFile("/workspace/pixel.png", png);

    const result = await tools.execute({
      id: "1",
      name: "read",
      arguments: { path: "/workspace/pixel.png" },
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});
