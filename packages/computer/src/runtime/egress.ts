export const WORKSPACE_EGRESS_TOKEN_HEADER = "x-workspace-egress-token";

export type WorkspaceEgressPolicy =
  | { mode: "none" }
  | { mode: "direct" }
  | { mode: "http-gateway"; gateway: Fetcher; revision?: string };

export function dynamicWorkerEgress(policy: WorkspaceEgressPolicy): {
  globalOutbound?: Fetcher | null;
} {
  switch (policy.mode) {
    case "none":
      return { globalOutbound: null };
    case "direct":
      return {};
    case "http-gateway":
      return { globalOutbound: policy.gateway };
  }
}
