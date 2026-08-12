import type { WorkspaceRuntimeLoader } from "@cloudflare/computer";
import type { CelldWorkspace, FilesystemAgent } from "./src/index";

declare global {
  interface Env {
    WORKSPACE: DurableObjectNamespace<CelldWorkspace>;
    FilesystemAgent: DurableObjectNamespace<FilesystemAgent>;
    // celld injects this binding when started with CELLD_WORKER_LOADER=LOADER.
    LOADER?: WorkspaceRuntimeLoader;
  }
}
