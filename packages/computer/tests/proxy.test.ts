// WorkspaceProxy is the WorkerEntrypoint a container DO hands to
// ctx.container.interceptOutboundHttp(...) so computerd can dial back
// into the DO. Two-and-a-half pieces of logic to pin:
//
//   - /health answers 200 ok\n (the port-readiness probe).
//   - /ws looks up env[binding] and forwards the request to the
//     named DO instance.
//   - anything else is 404.
//
// Plus an error path: a missing binding name returns 500 with a
// clear message instead of crashing.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./proxy-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function freshId(): string {
  // Mint a fresh DO id each test so cases stay independent.
  return env.COMPUTERD.newUniqueId().toString();
}

describe("WorkspaceProxy", () => {
  it("answers /health with 200 and the documented body", async () => {
    const res = await SELF.fetch("http://proxy.test/health", {
      headers: { "x-test-id": freshId() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  });

  it("/ws forwards to the DO at env[binding]", async () => {
    const res = await SELF.fetch("http://proxy.test/ws", {
      headers: { "x-test-id": freshId(), "x-test-binding": "COMPUTERD" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-do");
  });

  it("accepts tokenized callback health and forwards a normalized tokenized /ws", async () => {
    const token = "123e4567-e89b-12d3-a456-426614174000";
    const health = await SELF.fetch(`http://proxy.test/__workspace_connect/${token}/health`, {
      headers: { "x-test-id": freshId() },
    });
    expect(health.status).toBe(200);
    const websocket = await SELF.fetch(`http://proxy.test/__workspace_connect/${token}/ws`, {
      headers: { "x-test-id": freshId(), "x-test-binding": "COMPUTERD" },
    });
    expect(await websocket.text()).toBe(`from-do:${token}`);
  });

  it("routes egress callbacks through /ws while preserving the original request", async () => {
    const res = await SELF.fetch("https://api.example.test/v1/data?format=json", {
      method: "POST",
      body: "payload",
      headers: {
        "content-type": "text/plain",
        "x-test-id": freshId(),
        "x-test-egress-token": "secret-token",
      },
    });

    expect(await res.json()).toEqual({
      callbackUrl: "https://api.example.test/ws",
      originalUrl: "https://api.example.test/v1/data?format=json",
      egressToken: "secret-token",
      method: "POST",
      body: "payload",
    });
  });

  it("/ws returns 500 when env[binding] is missing", async () => {
    const res = await SELF.fetch("http://proxy.test/ws", {
      headers: { "x-test-id": freshId(), "x-test-binding": "NOT_A_BINDING" },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/NOT_A_BINDING is not a DurableObjectNamespace/);
  });

  it("returns 404 for paths other than /health and /ws", async () => {
    const res = await SELF.fetch("http://proxy.test/anything-else", {
      headers: { "x-test-id": freshId() },
    });
    expect(res.status).toBe(404);
  });
});
