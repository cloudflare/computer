// Unit tests for the pure host-side capability logic: wrapping/branding,
// target-shape reflection, callable-surface classification, and the fetch
// capability's allowlist + response mapping. Everything here runs in plain
// Node — end-to-end capability behavior (bridge, recording, replay) is
// covered by the workerd integration suite in tests/repl-capabilities.test.ts.

import { describe, expect, it } from "vitest";

import {
  capability,
  describeCapabilityTarget,
  fetchCapability,
  hasCallableSurface,
  isReplCapability,
  type ReplFetchResponse,
} from "./capability.js";

describe("capability()", () => {
  it("wraps objects and functions, carrying meta", () => {
    const target = { ping: () => "pong" };
    const wrapped = capability(target, { description: "pinger", docs: { ping: "ping() → pong" } });
    expect(wrapped.target).toBe(target);
    expect(wrapped.meta.description).toBe("pinger");
    expect(wrapped.meta.docs?.ping).toBe("ping() → pong");
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(capability(() => 1).meta).toEqual({});
  });

  it("rejects null and primitive targets", () => {
    expect(() => capability(null as never)).toThrow(TypeError);
    expect(() => capability(42 as never)).toThrow("needs an object or function");
    expect(() => capability("hi" as never)).toThrow(TypeError);
  });

  it("isReplCapability() accepts only branded wrappers", () => {
    expect(isReplCapability(capability({ m: () => 1 }))).toBe(true);
    expect(isReplCapability({ target: {}, meta: {} })).toBe(false);
    expect(isReplCapability(null)).toBe(false);
    expect(isReplCapability("capability")).toBe(false);
  });
});

describe("describeCapabilityTarget()", () => {
  it("splits methods from data and encodes data values", () => {
    const shape = describeCapabilityTarget({
      get: (id: string) => id,
      region: "eu-west",
      updated: new Date(1700000000000),
    });
    expect(shape.methods).toEqual(["get"]);
    expect(shape.data["region"]).toBe("eu-west");
    expect(shape.data["updated"]).toEqual({ $repl: "date", v: 1700000000000 });
    expect(shape.callable).toBeUndefined();
    expect(shape.opaque).toBeUndefined();
  });

  it("nests objects with callable surface as children, keeps plain data flat", () => {
    const shape = describeCapabilityTarget({
      users: { list: () => [], role: "admin" },
      limits: { rps: 10 },
    });
    expect(Object.keys(shape.children)).toEqual(["users"]);
    expect(shape.children["users"]?.methods).toEqual(["list"]);
    expect(shape.children["users"]?.data["role"]).toBe("admin");
    expect(shape.data["limits"]).toEqual({ rps: 10 });
  });

  it("finds class methods across the prototype chain, once", () => {
    class Base {
      close() {}
    }
    class Tab extends Base {
      url = "about:blank";
      read() {}
      click() {}
    }
    const shape = describeCapabilityTarget(new Tab());
    expect(shape.methods.sort()).toEqual(["click", "close", "read"]);
    expect(shape.data["url"]).toBe("about:blank");
    expect(shape.opaque).toBeUndefined();
  });

  it("marks bare functions callable, including attached helper methods", () => {
    const send = (to: string) => to;
    send.preview = () => "preview";
    const shape = describeCapabilityTarget(send);
    expect(shape.callable).toBe(true);
    expect(shape.methods).toEqual(["preview"]);
  });

  it("rejects callable surfaces nested beyond the depth ceiling", () => {
    const deep = { a: { b: { c: { d: { m: () => 1 } } } } };
    expect(() => describeCapabilityTarget(deep)).toThrow("Flatten the target");
  });

  it("rejects grant data the log cannot record, at reflection time", () => {
    expect(() => describeCapabilityTarget({ token: Symbol("secret") })).toThrow(
      "cannot be recorded",
    );
  });

  it("marks unreflectable non-plain objects opaque (RPC stubs)", () => {
    // Nothing enumerable, nothing on a walkable prototype — the shape of a
    // service-binding / DO stub whose properties materialize on access.
    const stub = new Proxy(
      {},
      { get: () => () => "materialized", getPrototypeOf: () => null },
    );
    const shape = describeCapabilityTarget(stub);
    expect(shape.opaque).toBe(true);
    expect(shape.methods).toEqual([]);
    // A plain empty object is NOT opaque — it's just an empty grant.
    expect(describeCapabilityTarget({}).opaque).toBeUndefined();
  });
});

describe("hasCallableSurface()", () => {
  it("classifies functions, methodful objects, and class instances as callable", () => {
    expect(hasCallableSurface(() => 1)).toBe(true);
    expect(hasCallableSurface({ m: () => 1 })).toBe(true);
    expect(hasCallableSurface({ nested: { deep: { m: () => 1 } } })).toBe(true);
    expect(hasCallableSurface(new (class X {})())).toBe(true);
    expect(hasCallableSurface([() => 1])).toBe(true);
  });

  it("classifies plain data and encodable exotics as data", () => {
    expect(hasCallableSurface({ a: 1, b: [2, 3] })).toBe(false);
    expect(hasCallableSurface(null)).toBe(false);
    expect(hasCallableSurface(42)).toBe(false);
    expect(hasCallableSurface(new Date())).toBe(false);
    expect(hasCallableSurface(new Map([[1, 2]]))).toBe(false);
    expect(hasCallableSurface(new Set([1]))).toBe(false);
    expect(hasCallableSurface(new Uint8Array(4))).toBe(false);
    expect(hasCallableSurface(new ArrayBuffer(4))).toBe(false);
    expect(hasCallableSurface([1, "two"])).toBe(false);
  });
});

type FetchTarget = (url: string, init?: never) => Promise<ReplFetchResponse>;

describe("fetchCapability()", () => {
  it("generates a description matching each egress mode", () => {
    expect(fetchCapability().meta.description).toBe(
      "HTTP fetch with the host worker's network access",
    );
    expect(fetchCapability({ fetch: async () => new Response() }).meta.description).toBe(
      "HTTP fetch routed through a host-provided gateway",
    );
    expect(fetchCapability({ allow: ["api.example.com"] }).meta.description).toBe(
      "HTTP fetch restricted to: api.example.com",
    );
    expect(fetchCapability({ allow: [] }).meta.description).toBe(
      "HTTP fetch restricted to: (no hosts)",
    );
  });

  it("routes through a provided fetcher and maps init + response", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = {
      fetch: async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {} });
        return new Response('{"ok":true}', {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json", "x-request-id": "r1" },
        });
      },
    };
    const doFetch = fetchCapability(fetcher).target as FetchTarget;
    const res = await doFetch("https://internal.test/orders", {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: '{"sku":1}',
    } as never);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://internal.test/orders");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe('{"sku":1}');
    expect(res.status).toBe(201);
    expect(res.ok).toBe(true);
    expect(res.statusText).toBe("Created");
    expect(res.headers["x-request-id"]).toBe("r1");
    // Body is captured once; text()/json() are repeatable.
    expect(res.text()).toBe('{"ok":true}');
    expect(res.text()).toBe('{"ok":true}');
    expect(res.json()).toEqual({ ok: true });
    expect(res.json()).toEqual({ ok: true });
  });

  it("omits init fields that were not provided", async () => {
    let seen: RequestInit | undefined;
    const fetcher = {
      fetch: async (_url: string, init?: RequestInit) => {
        seen = init;
        return new Response("ok");
      },
    };
    const doFetch = fetchCapability(fetcher).target as FetchTarget;
    await doFetch("https://internal.test/");
    expect(seen).toEqual({});
  });

  it("json() surfaces a parse error for non-JSON bodies", async () => {
    const fetcher = { fetch: async () => new Response("<html>") };
    const doFetch = fetchCapability(fetcher).target as FetchTarget;
    const res = await doFetch("https://internal.test/");
    expect(() => res.json()).toThrow(SyntaxError);
  });

  it("enforces the allowlist by exact hostname, before any network call", async () => {
    const realFetch = globalThis.fetch;
    const hit: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      hit.push(String(url));
      return new Response("reached");
    }) as typeof fetch;
    try {
      const doFetch = fetchCapability({ allow: ["example.com"] }).target as FetchTarget;

      await expect(doFetch("https://evil.test/steal")).rejects.toMatchObject({
        name: "EgressDeniedError",
        message: expect.stringContaining('"evil.test"') as string,
      });
      // Exact match: subdomains of an allowed host are still denied.
      await expect(doFetch("https://api.example.com/")).rejects.toMatchObject({
        name: "EgressDeniedError",
      });
      expect(hit).toHaveLength(0); // denied before touching the network

      const res = await doFetch("https://example.com/data");
      expect(res.text()).toBe("reached");
      expect(hit).toEqual(["https://example.com/data"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
