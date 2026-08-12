import type { CelldWorkspace } from "./src/index";

declare global {
  interface Env {
    WORKSPACE: DurableObjectNamespace<CelldWorkspace>;
  }
}
