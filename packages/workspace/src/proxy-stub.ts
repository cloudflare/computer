// Node-only stub for WorkspaceProxy.
//
// The real WorkspaceProxy lives in ./proxy.ts and extends
// WorkerEntrypoint from cloudflare:workers. That import only
// resolves under workerd. Package.json's conditional exports send
// node consumers here instead so importing the module name doesn't
// blow up the import graph (e.g. in vitest's node runner).
//
// The class is structurally identical so type-only usages keep
// working; the constructor throws so any actual instantiation
// outside workerd surfaces a clear error.

import type { ArtifactsCLIInput, ArtifactsCLIResult } from "./artifacts/index.js";

export interface WorkspaceProxyProps {
  binding: string;
  id: string;
}

export class WorkspaceProxy {
  constructor() {
    throw new Error(
      "WorkspaceProxy is only available under workerd. " +
        "Re-export it from your Worker entrypoint and let the runtime " +
        "construct it via ctx.exports.WorkspaceProxy(...).",
    );
  }
  fetch(_request: Request): Promise<Response> {
    throw new Error("WorkspaceProxy.fetch is only callable under workerd.");
  }
}

export interface WorkspaceServiceProxyProps {
  binding: string;
  id: string;
}

export class ArtifactsCLITarget {
  constructor() {
    throw new Error("ArtifactsCLITarget is only available under workerd.");
  }
  cli(_input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> {
    throw new Error("ArtifactsCLITarget.cli is only callable under workerd.");
  }
}

export class WorkspaceServiceProxy {
  constructor() {
    throw new Error(
      "WorkspaceServiceProxy is only available under workerd. " +
        "Re-export it from your Worker entrypoint and let the runtime " +
        "construct it via ctx.exports.WorkspaceServiceProxy(...).",
    );
  }
  getWorkspace(): Promise<unknown> {
    throw new Error("WorkspaceServiceProxy.getWorkspace is only callable under workerd.");
  }
  getArtifacts(): Promise<ArtifactsCLITarget> {
    throw new Error("WorkspaceServiceProxy.getArtifacts is only callable under workerd.");
  }
  artifactsCLI(_input: ArtifactsCLIInput): Promise<ArtifactsCLIResult> {
    throw new Error("WorkspaceServiceProxy.artifactsCLI is only callable under workerd.");
  }
}
