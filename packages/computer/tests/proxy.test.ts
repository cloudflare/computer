// WorkspaceProxy is the WorkerEntrypoint a container DO hands to
// ctx.container.interceptOutboundHttp(...) so computerd can dial back
// into the DO. Two-and-a-half pieces of logic to pin:
//
//   - /health answers 200 ok\n (the port-readiness probe).
//   - /api looks up env[binding] and forwards the request to the
//     named DO instance.
//   - anything else is 404.
//
// Plus an error path: a missing binding name returns 500 with a
// clear message instead of crashing.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./proxy-worker";

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

  it("/api forwards to the DO at env[binding]", async () => {
    const res = await SELF.fetch("http://proxy.test/api", {
      headers: { "x-test-id": freshId(), "x-test-binding": "COMPUTERD" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-do");
  });

  it("accepts tokenized callback health and normalizes the tokenized callback to /api", async () => {
    const token = "123e4567-e89b-12d3-a456-426614174000";
    const health = await SELF.fetch(`http://proxy.test/__workspace_connect/${token}/health`, {
      headers: { "x-test-id": freshId() },
    });
    expect(health.status).toBe(200);
    const websocket = await SELF.fetch(`http://proxy.test/__workspace_connect/${token}/api`, {
      headers: { "x-test-id": freshId(), "x-test-binding": "COMPUTERD" },
    });
    expect(await websocket.text()).toBe(`from-do:${token}`);
  });

  it("routes egress callbacks through /api while preserving the original request", async () => {
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
      callbackUrl: "https://api.example.test/api",
      originalUrl: "https://api.example.test/v1/data?format=json",
      egressToken: "secret-token",
      method: "POST",
      body: "payload",
    });
  });

  it("/api returns 500 when env[binding] is missing", async () => {
    const res = await SELF.fetch("http://proxy.test/api", {
      headers: { "x-test-id": freshId(), "x-test-binding": "NOT_A_BINDING" },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/NOT_A_BINDING is not a DurableObjectNamespace/);
  });

  // A container outlives its durable object, so computerd reconnecting
  // through the proxy is often what wakes the object. An instance
  // woken by idFromString() never gets ctx.id.name, which breaks
  // anything (agents' Lifecycle) that needs the name. Issue #243.
  it("/api wakes the DO by name when props carry one", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("http://proxy.test/api", {
      headers: {
        "x-test-id": env.COMPUTERD.idFromName(name).toString(),
        "x-test-name": name,
        "x-test-report-name": "1",
      },
    });
    expect(await res.json()).toEqual({ name });
  });

  it("egress callbacks wake the DO by name when props carry one", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("https://api.example.test/anything", {
      headers: {
        "x-test-id": env.COMPUTERD.idFromName(name).toString(),
        "x-test-name": name,
        "x-test-egress-token": "secret-token",
        "x-test-report-name": "1",
      },
    });
    expect(await res.json()).toEqual({ name });
  });

  it("/api falls back to the id when the name does not match it", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("http://proxy.test/api", {
      headers: {
        "x-test-id": env.COMPUTERD.idFromName(name).toString(),
        "x-test-name": `other-${name}`,
        "x-test-report-name": "1",
      },
    });
    expect(await res.json()).toEqual({ name: null });
  });

  it("/api without a name still reaches the DO by id", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("http://proxy.test/api", {
      headers: {
        "x-test-id": env.COMPUTERD.idFromName(name).toString(),
        "x-test-report-name": "1",
      },
    });
    expect(await res.json()).toEqual({ name: null });
  });

  it("returns 404 for paths other than /health and /api", async () => {
    const res = await SELF.fetch("http://proxy.test/anything-else", {
      headers: { "x-test-id": freshId() },
    });
    expect(res.status).toBe(404);
  });
});

describe("WorkspaceServiceProxy", () => {
  it("wakes the DO by name when props carry one", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("http://proxy.test/__service/getWorkspace", {
      headers: { "x-test-id": env.COMPUTERD.idFromName(name).toString(), "x-test-name": name },
    });
    expect(await res.json()).toEqual({ name });
  });

  it("falls back to the id when the name does not match it", async () => {
    const name = `named-${crypto.randomUUID()}`;
    const res = await SELF.fetch("http://proxy.test/__service/getWorkspace", {
      headers: {
        "x-test-id": env.COMPUTERD.idFromName(name).toString(),
        "x-test-name": `other-${name}`,
      },
    });
    expect(await res.json()).toEqual({ name: null });
  });
});
