import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it, vi } from "vitest";

import { Workspace } from "../workspace.js";
import { type GitAuthResolver, type GitHttpRequest, withHostAuth } from "./auth.js";
import { createGitClient } from "./index.js";

// A transport that records each request and answers 401, so a
// network command stops after its first request.
function recordingHttp() {
  const requests: GitHttpRequest[] = [];
  return {
    requests,
    async request(request: GitHttpRequest) {
      requests.push(request);
      return {
        url: request.url,
        method: request.method ?? "GET",
        statusCode: 401,
        statusMessage: "Unauthorized",
        headers: {},
        body: [],
      };
    },
  };
}

describe("withHostAuth", () => {
  it("adds Basic credentials and asks with the repository URL", async () => {
    const http = recordingHttp();
    const resolve = vi.fn<GitAuthResolver>(() => ({ username: "x-access-token", password: "t0k" }));

    await withHostAuth(http, resolve).request({
      url: "https://github.com/acme/private.git/info/refs?service=git-upload-pack",
      headers: { "user-agent": "git/test" },
    });

    expect(resolve).toHaveBeenCalledWith({
      url: "https://github.com/acme/private.git",
      operation: "fetch",
    });
    expect(http.requests[0]?.headers).toEqual({
      "user-agent": "git/test",
      Authorization: `Basic ${btoa("x-access-token:t0k")}`,
    });
  });

  it("reports push for receive-pack requests", async () => {
    const http = recordingHttp();
    const operations: string[] = [];
    const client = withHostAuth(http, ({ operation }) => {
      operations.push(operation);
      return undefined;
    });

    await client.request({
      url: "https://example.test/r.git/info/refs?service=git-receive-pack",
    });
    await client.request({ url: "https://example.test/r.git/git-receive-pack", method: "POST" });
    await client.request({ url: "https://example.test/r.git/git-upload-pack", method: "POST" });

    expect(operations).toEqual(["push", "push", "fetch"]);
  });

  it("passes headers through and lets them carry their own Authorization", async () => {
    const http = recordingHttp();
    await withHostAuth(http, () => ({
      headers: { Authorization: "Bearer abc", "X-Extra": "1" },
    })).request({ url: "https://example.test/r.git/info/refs?service=git-upload-pack" });

    expect(http.requests[0]?.headers).toEqual({ Authorization: "Bearer abc", "X-Extra": "1" });
  });

  it("leaves the request alone when the caller set Authorization", async () => {
    const http = recordingHttp();
    const resolve = vi.fn<GitAuthResolver>(() => ({ username: "u", password: "p" }));

    await withHostAuth(http, resolve).request({
      url: "https://example.test/r.git/info/refs?service=git-upload-pack",
      headers: { authorization: "Bearer caller" },
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(http.requests[0]?.headers).toEqual({ authorization: "Bearer caller" });
  });

  it("never sends credentials over plain http", async () => {
    const http = recordingHttp();
    const resolve = vi.fn<GitAuthResolver>(() => ({ username: "u", password: "p" }));

    await withHostAuth(http, resolve).request({
      url: "http://example.test/r.git/info/refs?service=git-upload-pack",
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(http.requests[0]?.headers).toBeUndefined();
  });

  it("sends the request without credentials when the resolver returns undefined", async () => {
    const http = recordingHttp();
    await withHostAuth(http, () => undefined).request({
      url: "https://example.test/r.git/info/refs?service=git-upload-pack",
      headers: { "user-agent": "git/test" },
    });

    expect(http.requests[0]?.headers).toEqual({ "user-agent": "git/test" });
  });

  it("encodes non-ASCII credentials as UTF-8", async () => {
    const http = recordingHttp();
    await withHostAuth(http, () => ({ username: "ü", password: "p" })).request({
      url: "https://example.test/r.git/info/refs?service=git-upload-pack",
    });

    expect(http.requests[0]?.headers?.Authorization).toBe("Basic w7w6cA==");
  });
});

describe("createGitClient({ auth })", () => {
  const url = "https://git.example.test/acme/private.git";

  function setup() {
    const http = recordingHttp();
    const auth = vi.fn<GitAuthResolver>(() => ({ username: "x-access-token", password: "t0k" }));
    const ws = new Workspace({
      git: createGitClient({ auth, http }),
      storage: new SQLiteTestStorage(),
    });
    const expected = `Basic ${btoa("x-access-token:t0k")}`;
    return { http, auth, git: ws.git, expected, ws };
  }

  it("authenticates a typed clone", async () => {
    const { http, auth, git, expected } = setup();

    await expect(git.clone({ url, dir: "/repo" })).rejects.toThrow("401");

    expect(auth).toHaveBeenCalledWith({ url, operation: "fetch" });
    expect(http.requests[0]?.headers?.Authorization).toBe(expected);
  });

  it("authenticates a clone from the CLI without a token in argv", async () => {
    const { http, git, expected } = setup();

    const result = await git.cli({ argv: ["clone", url, "repo"], cwd: "/" });

    expect(result.exitCode).not.toBe(0);
    expect(http.requests[0]?.headers?.Authorization).toBe(expected);
    expect(result.stdout + result.stderr).not.toContain("t0k");
  });

  it("asks for push credentials when pushing", async () => {
    const { http, auth, git, expected, ws } = setup();
    await git.init({ dir: "/repo" });
    await ws.fs.writeFile("/repo/README.md", "hi\n");
    await git.add({ dir: "/repo", paths: ["README.md"] });
    await git.commit({
      dir: "/repo",
      message: "x",
      author: { name: "T", email: "t@example.test" },
    });
    await git.remoteAdd({ dir: "/repo", name: "origin", url });

    const result = await git.cli({ argv: ["push", "origin", "main"], cwd: "/repo" });

    expect(result.exitCode).not.toBe(0);
    expect(auth).toHaveBeenCalledWith({ url, operation: "push" });
    expect(http.requests[0]?.url).toContain("service=git-receive-pack");
    expect(http.requests[0]?.headers?.Authorization).toBe(expected);
  });

  it("lets headers passed on the call win over the resolver", async () => {
    const { http, auth, git } = setup();

    await expect(
      git.clone({ url, dir: "/repo", headers: { Authorization: "Bearer caller" } }),
    ).rejects.toThrow("401");

    expect(auth).not.toHaveBeenCalled();
    expect(http.requests[0]?.headers?.Authorization).toBe("Bearer caller");
  });
});
