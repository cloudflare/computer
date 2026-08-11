import type { WorkspaceEgressPolicy } from "@cloudflare/computer";

export type EgressMode = "none" | "all" | "custom";

export type FetchResult = { status: number; mimeType: string | null } | { error: string };

export function workspaceEgressPolicy(mode: string, gateway: () => Fetcher): WorkspaceEgressPolicy {
  switch (mode) {
    case "none":
      return { mode: "none" };
    case "all":
      return { mode: "direct" };
    case "custom":
      return { mode: "http-gateway", gateway: gateway(), revision: "v1" };
    default:
      throw new Error(`EGRESS_MODE must be "none", "all", or "custom"; got "${mode}"`);
  }
}

export function mimeType(contentType: string | null): string | null {
  return contentType?.split(";", 1)[0]?.trim() || null;
}

export function targetUrl(value: string | null): string {
  if (value === null || value.length === 0) {
    throw new Error("url query parameter is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("url must be a valid HTTP or HTTPS URL");
  }
  return url.href;
}

export function parseShellFetchResult(
  exitCode: number,
  stdout: string,
  stderr: string,
): FetchResult {
  if (exitCode !== 0) {
    return { error: stderr.trim() || `curl exited with code ${exitCode}` };
  }

  const [statusLine, contentType = ""] = stdout.trimEnd().split("\n");
  const status = Number(statusLine);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return { error: "curl returned an invalid status code" };
  }
  return { status, mimeType: mimeType(contentType) };
}

export function errorResult(error: unknown): FetchResult {
  return { error: error instanceof Error ? error.message : String(error) };
}
