import type { WorkspaceRuntimeLoader } from "@cloudflare/computer";
import type { CelldAgent } from "./src/index";

declare global {
  interface Env {
    CLOUDFLARE_ACCOUNT_ID: string;
    CLOUDFLARE_API_TOKEN: string;
    CelldAgent: DurableObjectNamespace<CelldAgent>;
    // celld injects this binding when started with CELLD_WORKER_LOADER=LOADER.
    LOADER?: WorkspaceRuntimeLoader;
  }
}
