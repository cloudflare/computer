// Host-held Git credentials.
//
// `createGitClient({ auth })` takes a resolver that the host runs
// for every HTTPS request a clone, fetch, pull, or push makes. The
// resolver returns credentials for the repository, and they go on
// the request as an `Authorization` header. The model never sees
// them: they are not in argv, the remote URL, `.git/config`, or the
// command output.
//
// The resolver sits on the HTTP transport rather than on each
// command, so every way into Git gets it: the typed client, `cli()`,
// the worker-shell `git` command, and `ws:git`. Credentials the
// caller passes on a call (an `Authorization` header) win, and the
// resolver is not asked.

import type { GitAuth } from "./network.js";

/** What a request is for. `push` writes to the remote; everything else reads. */
export type GitAuthOperation = "fetch" | "push";

/** The request the host is asked to authenticate. */
export interface GitAuthRequest {
  /**
   * Repository URL, without the smart-HTTP suffix Git adds
   * (`/info/refs`, `/git-upload-pack`, `/git-receive-pack`) or a query
   * string. For example `https://github.com/acme/private.git`.
   */
  url: string;
  /** `push` for requests that write to the remote, `fetch` for the rest. */
  operation: GitAuthOperation;
}

/**
 * Returns credentials for a repository, or `undefined` to send the
 * request without any. Runs on the host for every HTTPS request, so
 * cache tokens yourself if minting one is slow.
 */
export type GitAuthResolver = (
  request: GitAuthRequest,
) => GitAuth | undefined | Promise<GitAuth | undefined>;

/** The part of isomorphic-git's HTTP client the resolver wraps. */
export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface GitHttpClient {
  request(request: GitHttpRequest): Promise<unknown>;
}

/**
 * Wrap an HTTP client so each HTTPS request asks `resolve` for
 * credentials, unless it already has an `Authorization` header.
 * Plain `http://` requests are never given credentials.
 */
export function withHostAuth(http: GitHttpClient, resolve: GitAuthResolver): GitHttpClient {
  return {
    async request(request) {
      const headers = request.headers ?? {};
      if (hasAuthorization(headers) || !request.url.startsWith("https://")) {
        return http.request(request);
      }
      const auth = await resolve({
        url: repositoryURL(request.url),
        operation: operationOf(request.url),
      });
      if (auth === undefined) return http.request(request);
      return http.request({ ...request, headers: { ...headers, ...authHeaders(auth) } });
    },
  };
}

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

// Git's smart-HTTP protocol asks for `<repo>/info/refs?service=...`
// and then posts to `<repo>/git-upload-pack` or
// `<repo>/git-receive-pack`. Strip those so the resolver sees the
// URL the user cloned.
function repositoryURL(requestURL: string): string {
  const url = new URL(requestURL);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/(info\/refs|git-upload-pack|git-receive-pack)$/, "");
  return url.toString();
}

function operationOf(requestURL: string): GitAuthOperation {
  const url = new URL(requestURL);
  return url.pathname.endsWith("/git-receive-pack") ||
    url.searchParams.get("service") === "git-receive-pack"
    ? "push"
    : "fetch";
}

function authHeaders(auth: GitAuth): Record<string, string> {
  const headers: Record<string, string> = { ...auth.headers };
  if (!hasAuthorization(headers) && (auth.username !== undefined || auth.password !== undefined)) {
    headers.Authorization = `Basic ${base64(`${auth.username ?? ""}:${auth.password ?? ""}`)}`;
  }
  return headers;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
