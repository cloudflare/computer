import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { Workspace } from "../workspace";
import { withFetch } from "./http";
import { createGitClient } from "./index";

async function collect(body: AsyncIterable<Uint8Array>) {
  const chunks = [];
  for await (const chunk of body) chunks.push(...chunk);
  return chunks;
}

describe("Fetch transport", () => {
  it("bridges streaming uploads, response bytes, headers and status", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ Authorization: "Bearer caller" });
      expect(await new Response(init?.body).arrayBuffer()).toEqual(
        new Uint8Array([1, 2, 3]).buffer,
      );
      const response = new Response(new Uint8Array([4, 5]), {
        status: 201,
        statusText: "Created",
        headers: { "X-Test": "yes" },
      });
      Object.defineProperty(response, "url", { value: "https://redirect.test/repo" });
      return response;
    });
    const signal = new AbortController().signal;
    const result = await withFetch(fetcher).request({
      url: "https://example.test/repo",
      method: "POST",
      headers: { Authorization: "Bearer caller" },
      signal,
      body: (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3]);
      })(),
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(signal);
    expect(result).toMatchObject({
      url: "https://redirect.test/repo",
      method: "POST",
      statusCode: 201,
      statusMessage: "Created",
      headers: { "x-test": "yes" },
    });
    expect(await collect((result as { body: AsyncIterable<Uint8Array> }).body)).toEqual([4, 5]);
  });

  it("handles GET and empty responses without manufacturing an upload body", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return new Response(null, { status: 204 });
    });
    const result = await withFetch(fetcher).request({ url: "https://example.test/repo" });
    expect(await collect((result as { body: AsyncIterable<Uint8Array> }).body)).toEqual([]);
  });

  it("cancels the response stream when Git stops reading", async () => {
    const cancel = vi.fn<() => void>();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const result = await withFetch(async () => new Response(stream)).request({
      url: "https://example.test",
    });
    for await (const _chunk of (result as { body: AsyncIterable<Uint8Array> }).body) break;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("propagates fetch failures", async () => {
    await expect(
      withFetch(async () => {
        throw new Error("offline");
      }).request({ url: "https://example.test" }),
    ).rejects.toThrow("offline");
  });
});

describe("createGitClient({ fetch })", () => {
  const url = "https://git.example.test/acme/private.git";
  function setup() {
    const requests: Request[] = [];
    // Authentication is host policy, not a Git-specific callback.
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (
        new URL(request.url).origin === "https://git.example.test" &&
        !request.headers.has("Authorization")
      ) {
        request.headers.set("Authorization", "Bearer host-token");
      }
      requests.push(request);
      return new Response(null, { status: 401, statusText: "Unauthorized" });
    });
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      git: createGitClient({ fetch: fetcher }),
    });
    return { ws, git: ws.git, requests, fetcher };
  }

  it("uses the supplied fetch for a typed clone", async () => {
    const { git, requests } = setup();
    await expect(git.clone({ url, dir: "/repo" })).rejects.toThrow("401");
    expect(requests[0]?.url).toContain("service=git-upload-pack");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer host-token");
  });

  it("uses host credentials for CLI clone without leaking them to output", async () => {
    const { git, requests } = setup();
    const result = await git.cli({ argv: ["clone", url, "repo"], cwd: "/" });
    expect(result.exitCode).not.toBe(0);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer host-token");
    expect(result.stdout + result.stderr).not.toContain("host-token");
  });

  it("uses the same fetch for typed fetch, pull and CLI push", async () => {
    const { git, ws, requests } = setup();
    await git.init({ dir: "/repo" });
    await ws.fs.writeFile("/repo/README.md", "hi\n");
    await git.add({ dir: "/repo", paths: ["README.md"] });
    await git.commit({
      dir: "/repo",
      message: "x",
      author: { name: "T", email: "t@example.test" },
    });
    await git.remoteAdd({ dir: "/repo", name: "origin", url });
    await expect(git.fetch({ dir: "/repo" })).rejects.toThrow("401");
    await expect(
      git.pull({ dir: "/repo", author: { name: "T", email: "t@example.test" } }),
    ).rejects.toThrow("401");
    const result = await git.cli({ argv: ["push", "origin", "main"], cwd: "/repo" });
    expect(result.exitCode).not.toBe(0);
    expect(requests.map((r) => new URL(r.url).searchParams.get("service"))).toEqual([
      "git-upload-pack",
      "git-upload-pack",
      "git-receive-pack",
    ]);
    expect(requests.every((r) => r.headers.get("Authorization") === "Bearer host-token")).toBe(
      true,
    );
  });

  it("passes explicit Authorization through to the host fetch", async () => {
    const { git, requests } = setup();
    await expect(
      git.clone({ url, dir: "/repo", headers: { Authorization: "Bearer caller" } }),
    ).rejects.toThrow("401");
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer caller");
  });
});
