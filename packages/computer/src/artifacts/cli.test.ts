// Tests for the argv-driven artifacts CLI. These drive the
// dispatcher through a real ArtifactClient over the in-memory fake
// binding — no mocks — so the assertions cover the end-to-end shape
// a shell consumer sees: scoping, JSON output, secret handling, and
// the exit-code contract (0 ok, 1 op failed, 129 argv-shape error).

import { beforeEach, describe, expect, it } from "vitest";
import { FakeArtifactsBinding } from "../../tests/utilities/fake-artifacts-binding.js";
import { credentialURL } from "./cli.js";
import { createArtifact } from "./client.js";

function makeClient() {
  const binding = new FakeArtifactsBinding();
  const client = createArtifact(binding, "sess1");
  return { binding, client };
}

async function run(argv: string[]) {
  const { client } = makeClient();
  return client.cli({ argv });
}

describe("credentialURL", () => {
  it("embeds the token as basic-auth with the conventional x user", () => {
    expect(credentialURL("https://acct.example.net/git/repo.git", "art_v1_abc")).toBe(
      "https://x:art_v1_abc@acct.example.net/git/repo.git",
    );
  });

  it("strips the ?expires= hint so the password is the bare secret", () => {
    // The real binding's plaintext carries a trailing
    // `?expires=<ts>`; folding it in verbatim would corrupt the
    // password and the remote would 401.
    const url = credentialURL(
      "https://acct.example.net/git/repo.git",
      "art_v1_secret?expires=1700000000",
    );
    expect(url).toBe("https://x:art_v1_secret@acct.example.net/git/repo.git");
    expect(url).not.toContain("expires");
    expect(new URL(url).password).toBe("art_v1_secret");
  });

  it("splices userinfo textually without round-tripping through new URL", () => {
    // The remote may be a form workerd's URL parser rejects; the
    // helper must not depend on `new URL` parsing it.
    const url = credentialURL("https://h.example.net/git/ns/repo.git", "art_v1_x");
    expect(url).toBe("https://x:art_v1_x@h.example.net/git/ns/repo.git");
  });
});

describe("runArtifactsCLI", () => {
  let binding: FakeArtifactsBinding;
  let client: ReturnType<typeof createArtifact>;

  beforeEach(() => {
    ({ binding, client } = makeClient());
  });

  describe("help", () => {
    it("prints top-level help for `help` at exit 0", async () => {
      const res = await client.cli({ argv: ["help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("artifacts");
      expect(res.stdout).toContain("repo");
      expect(res.stdout).toContain("token");
    });

    it("treats --help and -h as aliases for help", async () => {
      const long = await client.cli({ argv: ["--help"] });
      const short = await client.cli({ argv: ["-h"] });
      expect(long.exitCode).toBe(0);
      expect(short.exitCode).toBe(0);
      expect(long.stdout).toBe(short.stdout);
    });

    it("prints top-level help and exits non-zero for no args", async () => {
      const res = await client.cli({ argv: [] });
      expect(res.exitCode).not.toBe(0);
      expect(res.stdout).toContain("artifacts");
    });

    it("prints repo group help for `repo --help`", async () => {
      const res = await client.cli({ argv: ["repo", "--help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("repo create");
      expect(res.stdout).toContain("repo import");
      expect(res.stdout).not.toContain("status");
    });

    it("prints token group help for `token --help`", async () => {
      const res = await client.cli({ argv: ["token", "--help"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain("token create");
      expect(res.stdout).toContain("token delete");
    });

    it("explains session scoping in the top-level help", async () => {
      const res = await client.cli({ argv: ["help"] });
      expect(res.stdout.toLowerCase()).toContain("session");
    });

    it("tells an unscoped caller that names are namespace-wide", async () => {
      // Help is the contract a shell consumer reads. Promising a
      // session prefix that is not being applied would be worse than
      // saying nothing.
      const res = await createArtifact(binding).cli({ argv: ["help"] });
      expect(res.stdout).toContain("not scoped to a session");
      expect(res.stdout).toContain("every repository in the namespace");
      expect(res.stdout).not.toContain("implicitly scoped");
    });

    it("drops the session-scoping line from group help when unscoped", async () => {
      const unscoped = createArtifact(binding);
      const repo = await unscoped.cli({ argv: ["repo", "--help"] });
      const token = await unscoped.cli({ argv: ["token", "--help"] });
      expect(repo.stdout).not.toContain("session-scoped");
      expect(token.stdout).not.toContain("session-scoped");
      expect(repo.stdout).toContain("repo create");
      expect(token.stdout).toContain("token create");
    });
  });

  describe("unknown commands", () => {
    it("rejects an unknown group with exit 1", async () => {
      const res = await client.cli({ argv: ["bogus"] });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("bogus");
    });

    it("rejects an unknown repo subcommand with exit 1", async () => {
      const res = await client.cli({ argv: ["repo", "frobnicate"] });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("frobnicate");
    });
  });

  describe("repo create", () => {
    it("creates a repo and prints JSON with the local name", async () => {
      const res = await client.cli({ argv: ["repo", "create", "starter"] });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.name).toBe("starter");
      expect(json.remote).toContain("sess1__starter.git");
      expect(binding.repos.has("sess1__starter")).toBe(true);
    });

    it("forwards --description and --default-branch", async () => {
      const res = await client.cli({
        argv: ["repo", "create", "starter", "--description", "hi", "--default-branch", "trunk"],
      });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.defaultBranch).toBe("trunk");
      expect(json.description).toBe("hi");
    });

    it("exits 129 when the name is missing", async () => {
      const res = await client.cli({ argv: ["repo", "create"] });
      expect(res.exitCode).toBe(129);
    });

    it("exits 1 when the repo already exists", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["repo", "create", "starter"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("repo get", () => {
    it("prints JSON metadata for an existing repo", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["repo", "get", "starter"] });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.name).toBe("starter");
    });

    it("exits 1 when the repo does not exist", async () => {
      const res = await client.cli({ argv: ["repo", "get", "ghost"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("repo list", () => {
    it("prints a JSON array of the session's repos", async () => {
      await client.cli({ argv: ["repo", "create", "alpha"] });
      await client.cli({ argv: ["repo", "create", "beta"] });
      const res = await client.cli({ argv: ["repo", "list"] });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.map((r: { name: string }) => r.name).sort()).toEqual(["alpha", "beta"]);
      expect(json[0]).not.toHaveProperty("remote");
      expect(json[0]).not.toHaveProperty("status");
      expect(json[0]).toHaveProperty("defaultBranch");
    });

    it("prints an empty array when the session has no repos", async () => {
      const res = await client.cli({ argv: ["repo", "list"] });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual([]);
    });

    it("prints every repository in the namespace when unscoped", async () => {
      await client.cli({ argv: ["repo", "create", "alpha"] });
      const res = await createArtifact(binding).cli({ argv: ["repo", "list"] });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).map((r: { name: string }) => r.name)).toEqual(["sess1__alpha"]);
    });
  });

  describe("repo delete", () => {
    it("deletes a repo and confirms", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["repo", "delete", "starter"] });
      expect(res.exitCode).toBe(0);
      expect(binding.repos.has("sess1__starter")).toBe(false);
    });

    it("exits 1 when the repo does not exist", async () => {
      const res = await client.cli({ argv: ["repo", "delete", "ghost"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("repo import", () => {
    it("imports an external remote", async () => {
      const res = await client.cli({
        argv: ["repo", "import", "mirror", "--url", "https://github.com/example/repo"],
      });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.name).toBe("mirror");
      const info = await binding.get("sess1__mirror");
      expect(info.source).toBe("https://github.com/example/repo");
    });

    it("exits 129 when --url is missing", async () => {
      const res = await client.cli({ argv: ["repo", "import", "mirror"] });
      expect(res.exitCode).toBe(129);
    });
  });

  describe("token create", () => {
    it("mints a token and prints the plaintext", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({
        argv: ["token", "create", "starter", "--scope", "read", "--ttl", "3600"],
      });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.scope).toBe("read");
      expect(json.plaintext).toMatch(/^art_v1_/);
    });

    it("exits 129 on an invalid scope", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({
        argv: ["token", "create", "starter", "--scope", "admin"],
      });
      expect(res.exitCode).toBe(129);
    });
  });

  // `share` mints a token for an existing repo and prints just the
  // credentialed remote URL on stdout — a single clone/push-ready
  // string a caller can hand off without parsing JSON.
  describe("share (shorthand)", () => {
    it("prints a single credentialed remote URL", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["share", "starter", "--scope", "read"] });
      expect(res.exitCode).toBe(0);
      const url = res.stdout.trim();
      // One line, no JSON envelope.
      expect(url.split("\n")).toHaveLength(1);
      expect(url.startsWith("https://x:")).toBe(true);
      expect(url).toContain("art_v1_");
      expect(url).toContain("sess1__starter.git");
      // The expires hint must not leak into the password.
      expect(url).not.toContain("?expires=");
      const info = await binding.get("sess1__starter");
      expect(url).toBe(credentialURL(info.remote, new URL(url).password));
    });

    it("defaults the scope to read", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["share", "starter"] });
      expect(res.exitCode).toBe(0);
      const tokens = await binding.get("sess1__starter").then((r) => r.listTokens());
      // Two tokens: the repo-create initial write token, plus this
      // read share token.
      const shared = tokens.tokens.find((t) => t.scope === "read");
      expect(shared).toBeDefined();
    });

    it("accepts a unit-suffixed --ttl", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["share", "starter", "--ttl", "30m"] });
      expect(res.exitCode).toBe(0);
    });

    it("exits 129 on a malformed --ttl", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["share", "starter", "--ttl", "5w"] });
      expect(res.exitCode).toBe(129);
    });

    it("exits 129 on an invalid scope", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["share", "starter", "--scope", "admin"] });
      expect(res.exitCode).toBe(129);
    });

    it("exits 129 when the name is missing", async () => {
      const res = await client.cli({ argv: ["share"] });
      expect(res.exitCode).toBe(129);
    });

    it("exits 1 when the repo does not exist", async () => {
      const res = await client.cli({ argv: ["share", "ghost"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("token list", () => {
    it("prints token metadata without any plaintext", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["token", "list", "starter"] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("art_v1_");
      const json = JSON.parse(res.stdout);
      expect(Array.isArray(json.tokens)).toBe(true);
    });
  });

  describe("token get", () => {
    it("prints a single token's metadata", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const created = JSON.parse(
        (await client.cli({ argv: ["token", "create", "starter"] })).stdout,
      );
      const res = await client.cli({ argv: ["token", "get", "starter", created.id] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain("art_v1_");
      const json = JSON.parse(res.stdout);
      expect(json.id).toBe(created.id);
      expect(json).not.toHaveProperty("plaintext");
    });

    it("exits 1 when the token id is unknown", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["token", "get", "starter", "nope"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("token delete", () => {
    it("revokes a token and confirms", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const created = JSON.parse(
        (await client.cli({ argv: ["token", "create", "starter"] })).stdout,
      );
      const res = await client.cli({ argv: ["token", "delete", "starter", created.id] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe("Revoked token\n");
    });

    it("does not echo plaintext when revoking by plaintext", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const created = JSON.parse(
        (await client.cli({ argv: ["token", "create", "starter"] })).stdout,
      );
      const res = await client.cli({ argv: ["token", "delete", "starter", created.plaintext] });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).not.toContain(created.plaintext);
      expect(res.stderr).not.toContain(created.plaintext);
    });

    it("exits 1 when the token cannot be revoked", async () => {
      await client.cli({ argv: ["repo", "create", "starter"] });
      const res = await client.cli({ argv: ["token", "delete", "starter", "nope"] });
      expect(res.exitCode).toBe(1);
    });
  });

  describe("invalid names", () => {
    it("exits 1 when a repo name contains a slash", async () => {
      const res = await run(["repo", "create", "a/b"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr.toLowerCase()).toContain("invalid");
    });
  });

  // The composed shorthand: create repo, mint a token, register a
  // git remote whose URL carries the token. The git step is the
  // injected `remoteAdd` seam — the artifacts package never imports
  // git. A fake records the calls and simulates a name conflict.
  describe("create (shorthand)", () => {
    interface RemoteCall {
      name: string;
      url: string;
      force: boolean;
    }

    function makeRemoteAdd(options: { existing?: string[] } = {}) {
      const calls: RemoteCall[] = [];
      const existing = new Set(options.existing ?? []);
      const remoteAdd = async (opts: { name: string; url: string; force?: boolean }) => {
        const force = opts.force === true;
        calls.push({ name: opts.name, url: opts.url, force });
        if (existing.has(opts.name) && !force) {
          return { ok: false, exists: true, message: `remote ${opts.name} already exists` };
        }
        existing.add(opts.name);
        return { ok: true };
      };
      return { remoteAdd, calls };
    }

    it("creates the repo, mints a token, and registers a credentialed remote", async () => {
      const { remoteAdd, calls } = makeRemoteAdd();
      const res = await client.cli({ argv: ["create", "starter"], remoteAdd });

      expect(res.exitCode).toBe(0);
      expect(binding.repos.has("sess1__starter")).toBe(true);
      const json = JSON.parse(res.stdout);
      expect(json.name).toBe("starter");
      expect(json.scope).toBe("write");
      expect(json.gitRemote).toBe("starter");
      expect(json.remoteRegistered).toBe(true);
      // The bare remote is non-secret; the credentialed one carries
      // the token as basic-auth and is the one that was registered.
      expect(json.remote).not.toContain("art_v1_");
      expect(json.credentialedRemote).toContain("art_v1_");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ name: "starter", force: false });
      expect(calls[0].url).toBe(json.credentialedRemote);
    });

    it("defaults the git remote name to the repo name", async () => {
      const { remoteAdd, calls } = makeRemoteAdd();
      await client.cli({ argv: ["create", "starter"], remoteAdd });
      expect(calls[0].name).toBe("starter");
    });

    it("honors --remote to register under a different name", async () => {
      const { remoteAdd, calls } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--remote", "origin"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(0);
      expect(calls[0].name).toBe("origin");
      expect(JSON.parse(res.stdout).gitRemote).toBe("origin");
    });

    it("mints a read-scoped token when asked", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--scope", "read"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).scope).toBe("read");
    });

    it("exits 129 on an invalid scope", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--scope", "admin"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(129);
    });

    it("accepts a unit-suffixed --ttl", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--ttl", "30m"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(0);
    });

    it("exits 129 on a malformed --ttl", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--ttl", "5w"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(129);
    });

    it("forwards --description and --default-branch to the repo", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({
        argv: ["create", "starter", "--description", "hi", "--default-branch", "trunk"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.defaultBranch).toBe("trunk");
    });

    it("exits 129 when the name is missing", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const res = await client.cli({ argv: ["create"], remoteAdd });
      expect(res.exitCode).toBe(129);
    });

    it("prints a git remote add line when no remoteAdd seam is wired", async () => {
      const res = await client.cli({ argv: ["create", "starter"] });
      expect(res.exitCode).toBe(0);
      const json = JSON.parse(res.stdout);
      expect(json.remoteRegistered).toBe(false);
      expect(json.remoteAddCommand).toContain("git remote add");
      expect(json.remoteAddCommand).toContain("starter");
    });

    // --- recovery / idempotence -------------------------------

    it("fails when the repo already exists, pointing at --force", async () => {
      const { remoteAdd } = makeRemoteAdd();
      await client.cli({ argv: ["create", "starter"], remoteAdd });

      const res = await client.cli({ argv: ["create", "starter"], remoteAdd });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("--force");
      expect(res.stderr.toLowerCase()).toContain("already exists");
    });

    it("reuses an existing repo under --force without re-creating it", async () => {
      const { remoteAdd } = makeRemoteAdd();
      const first = JSON.parse(
        (await client.cli({ argv: ["create", "starter"], remoteAdd })).stdout,
      );

      const res = await client.cli({ argv: ["create", "starter", "--force"], remoteAdd });
      expect(res.exitCode).toBe(0);
      const second = JSON.parse(res.stdout);
      // Same repo, but a freshly minted token.
      expect(second.name).toBe("starter");
      expect(second.credentialedRemote).not.toBe(first.credentialedRemote);
    });

    it("fails when the git remote already exists, pointing at --force", async () => {
      const { remoteAdd } = makeRemoteAdd({ existing: ["origin"] });
      const res = await client.cli({
        argv: ["create", "starter", "--remote", "origin"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("--force");
    });

    it("updates an existing git remote under --force", async () => {
      const { remoteAdd, calls } = makeRemoteAdd({ existing: ["origin"] });
      const res = await client.cli({
        argv: ["create", "starter", "--remote", "origin", "--force"],
        remoteAdd,
      });
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).remoteRegistered).toBe(true);
      expect(calls[0].force).toBe(true);
    });
  });
});
