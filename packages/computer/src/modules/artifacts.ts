// `ws:artifacts`: the Workspace's Artifacts client for isolate JavaScript.
//
//   import { create, get, list, importArtifact, deleteArtifact } from "ws:artifacts";
//
// Calls that change Artifacts need a read-write backend. Importing from
// a caller-chosen URL is denied unless the module is created with
// `allowNetwork: true`: the request runs from the host, so the
// isolate's own egress settings do not stop it.

import type { ArtifactClient } from "../artifacts/index.js";
import type {
  WorkspaceModuleCallContext,
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
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
  });
  return Object.assign(create, {
    description: `Git repositories stored in Cloudflare Artifacts: \`create(name)\`, \`get(name)\`, \`list()\`, \`importArtifact(name, source)\`, and \`deleteArtifact(name)\`.${allowNetwork ? "" : " Importing from a remote URL is not allowed."}`,
  });
}

function requireWrite(context: WorkspaceModuleCallContext, operation: string) {
  if (context.access !== "read-write") {
    throw new Error(`${operation} requires Workspace write access.`);
  }
}
