// `ws:artifacts`: the Workspace's Artifacts client for isolate JavaScript.
//
//   import { create, get, list, importArtifact, deleteArtifact } from "ws:artifacts";
//
// Calls that change Artifacts need a read-write backend. Importing from
// a caller-chosen URL is denied unless the module is created with
// `allowNetwork: true`: the request runs from the host, so the
// isolate's own egress settings do not stop it.

import { credentialURL } from "../artifacts/cli.js";
import { parseDuration } from "../artifacts/duration.js";
import type { ArtifactClient, ArtifactScope } from "../artifacts/index.js";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceModuleTypes,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

/** Options for {@link createArtifactsModule}. */
export interface ArtifactsModuleOptions {
  /**
   * Allow `importArtifact` from a caller-chosen remote URL. Defaults to
   * `false`. The request runs from the host, so the JavaScript
   * backend's egress settings do not apply to it.
   */
  readonly allowNetwork?: boolean;
}

/**
 * Build the `ws:artifacts` host module over the Workspace's Artifacts client.
 *
 * It exports `create`, `get`, `list`, `importArtifact`, and
 * `deleteArtifact`, with the same arguments as the matching
 * `ArtifactClient` methods.
 *
 * @param options - Whether remote imports are allowed.
 * @returns The module to pass as `modules["ws:artifacts"]`.
 */
export function createArtifactsModule(
  options: ArtifactsModuleOptions = {},
): WorkspaceModuleFactory {
  const allowNetwork = options.allowNetwork ?? false;

  // SAFETY for the casts below: the isolate's arguments pass through to the Artifacts client, as they did when ws:artifacts was built in. The client checks its own inputs.
  const create = (host: WorkspaceModuleHost): WorkspaceModuleFunctions => ({
    create([name, createOptions], context) {
      requireWrite(context, "Artifacts create");
      return host.artifacts.create(
        String(name),
        createOptions as unknown as Parameters<ArtifactClient["create"]>[1],
      );
    },
    get([name]) {
      return host.artifacts.get(String(name));
    },
    list() {
      return host.artifacts.list();
    },
    importArtifact([name, source, importOptions], context) {
      requireWrite(context, "Artifacts import");
      if (!allowNetwork) {
        throw new Error("Artifacts import requires createArtifactsModule({ allowNetwork: true }).");
      }
      return host.artifacts.import(
        String(name),
        source as unknown as Parameters<ArtifactClient["import"]>[1],
        importOptions as unknown as Parameters<ArtifactClient["import"]>[2],
      );
    },
    deleteArtifact([name], context) {
      requireWrite(context, "Artifacts delete");
      return host.artifacts.delete(String(name));
    },
    async createToken([name, scope, ttl], context) {
      const tokenScope = parseScope(scope, "createToken");
      if (tokenScope === "write") requireWrite(context, "A write token");
      const token = await host.artifacts.createToken(
        requireName(name, "createToken"),
        tokenScope,
        parseTtl(ttl, "createToken"),
      );
      return { ...token };
    },
    async share([name, shareOptions], context) {
      const repo = requireName(name, "share");
      const options = optionalObject(shareOptions, "share");
      const tokenScope = parseScope(options.scope, "share");
      if (tokenScope === "write") requireWrite(context, "A write token");
      const ttl = parseTtl(options.ttl, "share");
      const info = await host.artifacts.get(repo);
      const token = await host.artifacts.createToken(repo, tokenScope, ttl);
      return credentialURL(info.remote, token.plaintext);
    },
  });
  return Object.assign(create, {
    description: `Git repositories stored in Cloudflare Artifacts: \`create(name)\`, \`get(name)\`, \`list()\`, \`importArtifact(name, source)\`, and \`deleteArtifact(name)\`.${allowNetwork ? "" : " Importing from a remote URL is not allowed."} \`createToken(name, scope?, ttl?)\` mints a git token ("read" by default). \`share(name, { scope?, ttl? })\` returns a clone-ready URL with a token embedded; it is a credential, so never print or return it. \`ttl\` is seconds or a duration like "15m".`,
    types: artifactsTypes(allowNetwork),
    examples: [
      'const repo = await create("notes");',
      'const remote = await share("notes", { scope: "write", ttl: "15m" });',
    ],
  });
}

function artifactsTypes(allowNetwork: boolean): WorkspaceModuleTypes {
  return {
    ArtifactRepo: `interface ArtifactRepo {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
}`,
    CreatedArtifact: `/** \`token\` is a credential for \`remote\`. Never print or return it. */
interface CreatedArtifact {
  id: string;
  name: string;
  description: string | null;
  defaultBranch: string;
  remote: string;
  token: string;
}`,
    create: `/** Create a git repository. */
function create(
  name: string,
  options?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
): Promise<CreatedArtifact>;`,
    get: `/** A repository's details, including its HTTPS \`remote\`. Rejects when it does not exist. */
function get(name: string): Promise<ArtifactRepo & { remote: string }>;`,
    list: "function list(): Promise<ArtifactRepo[]>;",
    importArtifact: `/** Import an existing git remote as a new repository.${allowNetwork ? "" : " Not allowed here: importing from a remote URL needs network access."} */
function importArtifact(
  name: string,
  source: { url: string; branch?: string; depth?: number },
  options?: { description?: string; readOnly?: boolean },
): Promise<CreatedArtifact>;`,
    deleteArtifact:
      "/** Resolves false when the repository does not exist. */\nfunction deleteArtifact(name: string): Promise<boolean>;",
    createToken: `/**
 * Mint a git token for a repository. \`scope\` defaults to "read". \`ttl\` is
 * seconds or a duration such as "15m". \`plaintext\` is a credential.
 */
function createToken(
  name: string,
  scope?: "read" | "write",
  ttl?: number | string,
): Promise<{ id: string; plaintext: string; scope: "read" | "write"; expiresAt: string }>;`,
    share: `/**
 * The repository's HTTPS remote with a fresh token in it, ready to clone or push.
 * It is a credential: never print or return it.
 */
function share(name: string, options?: { scope?: "read" | "write"; ttl?: number | string }): Promise<string>;`,
  };
}

function requireWrite(context: WorkspaceModuleCallContext, operation: string) {
  if (context.access !== "read-write") {
    throw new Error(`${operation} requires Workspace write access.`);
  }
}

function requireName(value: WorkspaceRuntimeValue | undefined, operation: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${operation}: name must be a non-empty string.`);
  }
  return value;
}

function parseScope(value: WorkspaceRuntimeValue | undefined, operation: string): ArtifactScope {
  if (value === undefined || value === null) return "read";
  if (value === "read" || value === "write") return value;
  throw new TypeError(
    `${operation}: scope must be "read" or "write", got ${JSON.stringify(value)}.`,
  );
}

function parseTtl(value: WorkspaceRuntimeValue | undefined, operation: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(`${operation}: ttl must be a positive whole number of seconds.`);
    }
    return value;
  }
  if (typeof value === "string") {
    try {
      return parseDuration(value);
    } catch (error) {
      throw new TypeError(
        `${operation}: ttl ${JSON.stringify(value)} is not a duration like "15m": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new TypeError(`${operation}: ttl must be a number of seconds or a duration.`);
}

function optionalObject(
  value: WorkspaceRuntimeValue | undefined,
  operation: string,
): Record<string, WorkspaceRuntimeValue> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${operation}: options must be an object.`);
  }
  return value;
}
