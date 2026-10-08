import { describe, expect, it } from "vitest";

import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../runtime/types.js";
import { createArtifactsModule } from "./artifacts.js";

function fakeArtifacts() {
  const tokens: Array<{ name: string; scope: string | undefined; ttl: number | undefined }> = [];
  const gets: string[] = [];
  return {
    tokens,
    gets,
    client: {
      async get(name: string) {
        gets.push(name);
        if (name === "missing") throw new Error("repo not found");
        return { name, remote: `https://artifacts.example/git/${name}.git` };
      },
      async createToken(name: string, scope?: string, ttl?: number) {
        tokens.push({ name, scope, ttl });
        return {
          id: "tok_1",
          plaintext: "secret/value?expires=123",
          scope: scope ?? "read",
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
    },
  };
}

function build(artifacts: ReturnType<typeof fakeArtifacts>["client"]) {
  // SAFETY: The functions under test only call get and createToken.
  const host = { artifacts, git: undefined, runtime: undefined } as unknown as WorkspaceModuleHost;
  const functions = createArtifactsModule()(host);
  const { createToken, share } = functions;
  if (!createToken || !share) throw new Error("ws:artifacts must export createToken and share");
  return { createToken, share };
}

function callContext(access: "read" | "read-write" = "read-write"): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access,
    resolvePath: async (path) => path,
  };
}

describe("createArtifactsModule createToken", () => {
  it("mints a read token by default", async () => {
    const { client, tokens } = fakeArtifacts();
    const { createToken } = build(client);

    await expect(createToken(["repo"], callContext("read"))).resolves.toEqual({
      id: "tok_1",
      plaintext: "secret/value?expires=123",
      scope: "read",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(tokens).toEqual([{ name: "repo", scope: "read", ttl: undefined }]);
  });

  it("takes a ttl in seconds or as a duration", async () => {
    const { client, tokens } = fakeArtifacts();
    const { createToken } = build(client);

    await createToken(["repo", "write", 60], callContext());
    await createToken(["repo", null, "15m"], callContext());
    expect(tokens.map(({ scope, ttl }) => ({ scope, ttl }))).toEqual([
      { scope: "write", ttl: 60 },
      { scope: "read", ttl: 900 },
    ]);
  });

  it("refuses a write token without write access", async () => {
    const { client, tokens } = fakeArtifacts();
    const { createToken } = build(client);

    await expect(createToken(["repo", "write"], callContext("read"))).rejects.toThrow(
      /write access/,
    );
    expect(tokens).toEqual([]);
  });

  it.each([
    [[], /name must be a non-empty string/],
    [["repo", "admin"], /scope must be "read" or "write"/],
    [["repo", "read", 1.5], /positive whole number/],
    [["repo", "read", "soon"], /not a duration/],
    [["repo", "read", true], /number of seconds or a duration/],
  ])("rejects %j", async (args, message) => {
    const { client, tokens } = fakeArtifacts();
    const { createToken } = build(client);

    await expect(createToken(args as never, callContext())).rejects.toThrow(message);
    expect(tokens).toEqual([]);
  });
});

describe("createArtifactsModule share", () => {
  it("returns the repo's remote with a token embedded", async () => {
    const { client, tokens } = fakeArtifacts();
    const { share } = build(client);

    await expect(share(["repo"], callContext("read"))).resolves.toBe(
      "https://x:secret%2Fvalue@artifacts.example/git/repo.git",
    );
    expect(tokens).toEqual([{ name: "repo", scope: "read", ttl: undefined }]);
  });

  it("passes the scope and ttl through", async () => {
    const { client, tokens } = fakeArtifacts();
    const { share } = build(client);

    await share(["repo", { scope: "write", ttl: "2h" }], callContext());
    expect(tokens).toEqual([{ name: "repo", scope: "write", ttl: 7200 }]);
  });

  it("does not mint a token for a missing repo", async () => {
    const { client, tokens } = fakeArtifacts();
    const { share } = build(client);

    await expect(share(["missing"], callContext())).rejects.toThrow(/not found/);
    expect(tokens).toEqual([]);
  });

  it("refuses a write URL without write access", async () => {
    const { client, gets } = fakeArtifacts();
    const { share } = build(client);

    await expect(share(["repo", { scope: "write" }], callContext("read"))).rejects.toThrow(
      /write access/,
    );
    expect(gets).toEqual([]);
  });

  it("rejects options that are not an object", async () => {
    const { client } = fakeArtifacts();
    const { share } = build(client);

    await expect(share(["repo", "write"], callContext())).rejects.toThrow(/must be an object/);
  });

  it("describes both", () => {
    const description = createArtifactsModule().description ?? "";
    expect(description).toContain("createToken(name");
    expect(description).toContain("share(name");
  });
});
