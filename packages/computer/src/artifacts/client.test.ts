// Tests for the artifacts client. The fake binding stores names
// verbatim, so these assert the scoping contract from the outside:
// what the caller passes in (local names) versus what lands in the
// namespace (session-prefixed names), and that reads only ever
// surface the session's own repos with the prefix gone.
//
// The last block covers the other mode, a client built with no
// session id, where names go through untouched and every
// repository in the namespace is in reach.

import { beforeEach, describe, expect, it } from "vitest";
import { FakeArtifactsBinding } from "../../tests/utilities/fake-artifacts-binding.js";
import { createArtifact } from "./client.js";
import { NotFoundError } from "./errors.js";

describe("createArtifact", () => {
  let binding: FakeArtifactsBinding;

  beforeEach(() => {
    binding = new FakeArtifactsBinding();
  });

  it("exposes the session id", () => {
    const client = createArtifact(binding, "sess1");
    expect(client.sessionId).toBe("sess1");
  });

  it("validates the session id at construction time", () => {
    expect(() => createArtifact(binding, "")).toThrow();
    expect(() => createArtifact(binding, "a/b")).toThrow();
    expect(() => createArtifact(binding, "a__b")).toThrow();
  });

  describe("without a session id", () => {
    // An unscoped client is the namespace-wide door: names are the
    // ones the binding stores, nothing is prefixed on the way in or
    // filtered on the way out, and repositories belonging to scoped
    // sessions are ordinary repositories from here.

    it("constructs from the binding alone", () => {
      expect(() => createArtifact(binding)).not.toThrow();
      expect(() => createArtifact(binding, null)).not.toThrow();
    });

    it("reports no session id", () => {
      expect(createArtifact(binding).sessionId).toBeUndefined();
    });

    it("stores a created repo under the bare name", async () => {
      const client = createArtifact(binding);
      const result = await client.create("starter");
      expect(result.name).toBe("starter");
      expect(binding.has("starter")).toBe(true);
    });

    it("lists every repository in the namespace under its stored name", async () => {
      await createArtifact(binding, "sess1").create("alpha");
      await createArtifact(binding, "sess2").create("beta");
      await createArtifact(binding).create("loose");

      const repos = await createArtifact(binding).list();
      expect(repos.map((r) => r.name).sort()).toEqual(["loose", "sess1__alpha", "sess2__beta"]);
    });

    it("walks every page while listing the whole namespace", async () => {
      binding = new FakeArtifactsBinding({ pageSize: 1 });
      await createArtifact(binding, "sess1").create("alpha");
      await createArtifact(binding, "sess2").create("beta");

      const repos = await createArtifact(binding).list();
      expect(repos.map((r) => r.name).sort()).toEqual(["sess1__alpha", "sess2__beta"]);
    });

    it("reads a repository a scoped session created", async () => {
      await createArtifact(binding, "sess1").create("starter");
      const repo = await createArtifact(binding).get("sess1__starter");
      expect(repo.name).toBe("sess1__starter");
      expect(repo.remote).toContain("sess1__starter.git");
    });

    it("mints a token for a repository a scoped session created", async () => {
      await createArtifact(binding, "sess1").create("starter");
      const token = await createArtifact(binding).createToken("sess1__starter", "read");
      expect(token.scope).toBe("read");
      expect(token.plaintext).toMatch(/^art_v1_/);
    });

    it("deletes a repository a scoped session created", async () => {
      await createArtifact(binding, "sess1").create("starter");
      expect(await createArtifact(binding).delete("sess1__starter")).toBe(true);
      expect(binding.has("sess1__starter")).toBe(false);
    });

    it("writes into a session's namespace when named explicitly", async () => {
      // Namespace-wide access covers writes too: the name is taken
      // literally, so a scoped client picks this repo up as its own.
      await createArtifact(binding).create("sess1__adopted");
      expect(await createArtifact(binding, "sess1").list()).toEqual([
        expect.objectContaining({ name: "adopted" }),
      ]);
    });

    it("stays invisible to a scoped client when the name is bare", async () => {
      await createArtifact(binding).create("loose");
      expect(await createArtifact(binding, "sess1").list()).toEqual([]);
    });
  });

  describe("create", () => {
    it("stores the scoped name in the namespace", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      expect(binding.repos.has("sess1__starter")).toBe(true);
    });

    it("returns the local (unscoped) name", async () => {
      const client = createArtifact(binding, "sess1");
      const result = await client.create("starter");
      expect(result.name).toBe("starter");
    });

    it("returns the remote and an initial token verbatim", async () => {
      const client = createArtifact(binding, "sess1");
      const result = await client.create("starter");
      expect(result.remote).toContain("sess1__starter.git");
      expect(result.token).toMatch(/^art_v1_/);
    });

    it("forwards create options", async () => {
      const client = createArtifact(binding, "sess1");
      const result = await client.create("starter", {
        description: "desc",
        setDefaultBranch: "trunk",
      });
      expect(result.defaultBranch).toBe("trunk");
      expect(result.description).toBe("desc");
      // Stored under the scoped name in the namespace.
      expect(binding.has("sess1__starter")).toBe(true);
    });
  });

  describe("get", () => {
    it("resolves a scoped repo and unscopes the name", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      const repo = await client.get("starter");
      expect(repo.name).toBe("starter");
      expect(repo.remote).toContain("sess1__starter.git");
    });

    it("reads metadata through the handle's info() method", async () => {
      // The real binding's handle is an RpcTarget: its metadata is not
      // readable as stub properties (reading `handle.remote` yields an
      // RpcPromise for a nonexistent method), only through `info()`,
      // which returns the metadata by value. Model exactly that here:
      // a handle that exposes info() but throws on any property read.
      const metadata = {
        id: "repo_1",
        name: "sess1__starter",
        description: null,
        defaultBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastPushAt: null,
        source: null,
        readOnly: false,
        remote: "https://acct.example.net/git/sess1__starter.git",
      };
      const handle = new Proxy(
        { info: async () => ({ ...metadata }) },
        {
          get(target, prop) {
            if (prop === "info") return target.info;
            // `await` probes `then`; let non-string/thenable reads
            // through as undefined so the handle resolves normally.
            if (typeof prop !== "string" || prop === "then") return undefined;
            // Any metadata-field read is a bug: the client must go
            // through info(), not touch the stub's properties.
            throw new Error(`unexpected property read on handle: ${String(prop)}`);
          },
        },
      );
      const stubLikeBinding = {
        async get(_scoped: string) {
          return handle;
        },
      } as unknown as ConstructorParameters<typeof createArtifact>[0];

      const client = createArtifact(stubLikeBinding, "sess1");
      const repo = await client.get("starter");
      expect(repo.name).toBe("starter");
      expect(repo.remote).toBe("https://acct.example.net/git/sess1__starter.git");
      expect(repo.defaultBranch).toBe("main");
    });
  });

  describe("list", () => {
    it("returns only the session's repos with the prefix stripped", async () => {
      const sess1 = createArtifact(binding, "sess1");
      const sess2 = createArtifact(binding, "sess2");
      await sess1.create("alpha");
      await sess1.create("beta");
      await sess2.create("gamma");

      const repos = await sess1.list();
      const names = repos.map((r) => r.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    });

    it("walks every page of the binding", async () => {
      // Force the binding to chop its results into single-repo pages
      // so a naive single-call list would miss everything past the
      // first entry.
      binding = new FakeArtifactsBinding({ pageSize: 1 });
      const client = createArtifact(binding, "sess1");
      await client.create("a");
      await client.create("b");
      await client.create("c");

      const repos = await client.list();
      expect(repos.map((r) => r.name).sort()).toEqual(["a", "b", "c"]);
    });

    it("walks multiple pages while filtering foreign sessions", async () => {
      binding = new FakeArtifactsBinding({ pageSize: 1 });
      const sess1 = createArtifact(binding, "sess1");
      const sess2 = createArtifact(binding, "sess2");
      await sess1.create("a");
      await sess2.create("foreign");
      await sess1.create("b");

      const repos = await sess1.list();
      expect(repos.map((r) => r.name).sort()).toEqual(["a", "b"]);
    });

    it("returns an empty array when the session has no repos", async () => {
      const client = createArtifact(binding, "sess1");
      await createArtifact(binding, "other").create("x");
      expect(await client.list()).toEqual([]);
    });

    it("throws when the binding returns a repeated cursor", async () => {
      const realList = binding.list.bind(binding);
      binding.list = async (opts = {}) => ({
        ...(await realList(opts)),
        cursor: "same",
      });
      const client = createArtifact(binding, "sess1");
      await client.create("a");
      await expect(client.list()).rejects.toThrow("non-advancing cursor");
    });
  });

  describe("import", () => {
    it("scopes the target name and records the source", async () => {
      const client = createArtifact(binding, "sess1");
      const result = await client.import("mirror", {
        url: "https://github.com/example/repo",
        branch: "main",
      });
      expect(result.name).toBe("mirror");
      expect(binding.has("sess1__mirror")).toBe(true);
      // The imported repo records its source remote.
      const info = await binding.get("sess1__mirror");
      expect(info.source).toBe("https://github.com/example/repo");
    });
  });

  describe("delete", () => {
    it("deletes the scoped repo", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      expect(await client.delete("starter")).toBe(true);
      expect(binding.repos.has("sess1__starter")).toBe(false);
    });

    it("returns false when the repo does not exist", async () => {
      const client = createArtifact(binding, "sess1");
      expect(await client.delete("ghost")).toBe(false);
    });
  });

  describe("tokens", () => {
    it("creates a token scoped to a session repo", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      const token = await client.createToken("starter", "read", 3600);
      expect(token.scope).toBe("read");
      expect(token.plaintext).toMatch(/^art_v1_/);
    });

    it("lists tokens for a session repo", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      await client.createToken("starter", "read");
      const result = await client.listTokens("starter");
      // One initial token from create() plus the read token.
      expect(result.total).toBe(2);
    });

    it("gets a single token by id", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      const created = await client.createToken("starter", "read");
      const fetched = await client.getToken("starter", created.id as string);
      expect(fetched.id).toBe(created.id);
      expect(fetched.scope).toBe("read");
    });

    it("throws NotFoundError when the token id is unknown", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      await expect(client.getToken("starter", "nope")).rejects.toBeInstanceOf(NotFoundError);
    });

    it("revokes a token", async () => {
      const client = createArtifact(binding, "sess1");
      await client.create("starter");
      const created = await client.createToken("starter", "read");
      expect(await client.revokeToken("starter", created.id as string)).toBe(true);
      const fetched = await client.getToken("starter", created.id as string);
      expect(fetched.state).toBe("revoked");
    });
  });
});
