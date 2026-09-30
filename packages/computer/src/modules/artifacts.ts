// `ws:artifacts`: the Workspace's Artifacts client for isolate JavaScript.
//
//   import { create, get, list, importArtifact, deleteArtifact } from "ws:artifacts";
//
// Calls that change Artifacts need a read-write backend. Importing from
// a caller-chosen URL is denied unless the module is created with
// `allowNetwork: true`: the request runs from the host, so the
// isolate's own egress settings do not stop it.

import type { ArtifactClient } from "../artifacts/index.js";
import { defineModule } from "../runtime/module.js";
import type {
  WorkspaceHostModule,
  WorkspaceModuleCallContext,
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
export function createArtifactsModule(options: ArtifactsModuleOptions = {}): WorkspaceHostModule {
  const allowNetwork = options.allowNetwork ?? false;

  // SAFETY for the casts below: the isolate's arguments pass through to the Artifacts client, as they did when ws:artifacts was built in. The client checks its own inputs.
  return defineModule((host) => ({
    async create([name, createOptions], context) {
      requireWrite(context, "Artifacts create");
      return toRuntimeValue(
        await host.artifacts.create(
          String(name),
          createOptions as unknown as Parameters<ArtifactClient["create"]>[1],
        ),
      );
    },
    async get([name]) {
      return toRuntimeValue(await host.artifacts.get(String(name)));
    },
    async list() {
      return toRuntimeValue(await host.artifacts.list());
    },
    async importArtifact([name, source, importOptions], context) {
      requireWrite(context, "Artifacts import");
      if (!allowNetwork) {
        throw new Error("Artifacts import requires createArtifactsModule({ allowNetwork: true }).");
      }
      return toRuntimeValue(
        await host.artifacts.import(
          String(name),
          source as unknown as Parameters<ArtifactClient["import"]>[1],
          importOptions as unknown as Parameters<ArtifactClient["import"]>[2],
        ),
      );
    },
    async deleteArtifact([name], context) {
      requireWrite(context, "Artifacts delete");
      return host.artifacts.delete(String(name));
    },
  }));
}

function requireWrite(context: WorkspaceModuleCallContext, operation: string) {
  if (context.access !== "read-write") {
    throw new Error(`${operation} requires Workspace write access.`);
  }
}

// Artifacts results are plain data, but may carry `undefined` fields
// that the bridge rejects. A JSON round trip drops them.
function toRuntimeValue(value: unknown): WorkspaceRuntimeValue {
  // SAFETY: JSON.parse of a JSON.stringify result is always a JSON value.
  return JSON.parse(JSON.stringify(value ?? null)) as WorkspaceRuntimeValue;
}
