export const WORKSPACE_EGRESS_TOKEN_HEADER = "x-workspace-egress-token";
export const WORKSPACE_EGRESS_URL_HEADER = "x-workspace-egress-url";

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

/**
 * How the host makes a request on an isolate's behalf, under the same
 * policy the isolate's own `fetch` would follow. Absent for `none`.
 */
export function hostEgressFetch(policy: WorkspaceEgressPolicy): {
  fetch?: (request: Request) => Promise<Response>;
} {
  switch (policy.mode) {
    case "none":
      return {};
    case "direct":
      return { fetch: (request) => fetch(request) };
    case "http-gateway":
      return { fetch: (request) => policy.gateway.fetch(request) };
  }
}
