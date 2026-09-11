// The public Worker never forwards /codemode; the container reaches it
// through the egress interception, which lands on the Durable Object's
// fetch. These tests take the same door directly and drive the real
// runtime, facet, and dynamic worker against the notes connector.

import { env, SELF } from "cloudflare:test";
import type { CodemodeRPC } from "@cloudflare/computer-rpc";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";

function durableObject(name: string) {
  const { CodemodeExample } = env as unknown as { CodemodeExample: DurableObjectNamespace };
  return CodemodeExample.get(CodemodeExample.idFromName(name));
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

describe("codemode example", () => {
  it("keeps /codemode private and insists on a websocket", async () => {
    const home = await SELF.fetch("https://example.test/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("codemode types");
    const publicRoute = await SELF.fetch("https://example.test/codemode");
    expect(publicRoute.status).toBe(404);
    const plain = await durableObject("plain").fetch("https://example.test/codemode");
    expect(plain.status).toBe(400);
  });

  it("describes the notes connector and finds one method at a time", async () => {
    using api = await connect("discover");

    const declared = await api.types();
    expect(declared.connectors).toEqual(["notes"]);
    expect(declared.types).toContain("declare const notes:");
    expect(declared.types).toContain("add: (input: AddInput) => Promise<AddOutput>;");

    const found = await api.search("append a note");
    expect(found.results[0]?.path).toBe("notes.add");
    const described = await api.describe("notes.add");
    expect(described.kind).toBe("method");
    expect(described.types).toContain("AddInput");
  });

  it("runs scripts against the connector and reports failures as results", async () => {
    using api = await connect("run");

    const added = await api.execute({
      code: 'await notes.add({ text: "hello" }); console.log("added"); return await notes.list({});',
    });
    expect(added).toMatchObject({ status: "completed", result: ["hello"], logs: ["added"] });

    const failed = await api.execute({ code: 'throw new Error("nope");' });
    expect(failed.status).toBe("error");
    expect(failed.status === "error" && failed.error).toContain("nope");

    const blocked = await api.execute({
      code: 'return await fetch("https://example.com").then((r) => r.status);',
    });
    expect(blocked.status).toBe("error");
  });

  it("lists pending actions but offers no way to approve them", async () => {
    using api = await connect("pending");
    expect(await api.pending()).toEqual([]);
    // A capnweb stub proxies any name, so the proof is that the host
    // refuses the call: approving is not on the surface.
    const offSurface = api as unknown as { approve(input: unknown): Promise<unknown> };
    await expect(offSurface.approve({ executionId: "none" })).rejects.toThrow();
  });
});
