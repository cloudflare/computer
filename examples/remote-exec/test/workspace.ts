/** A session of the example: its workspace's files, codemode runs against it, and its container. */
import { inject } from "vitest";

export interface Workspace {
  /** Writes /workspace/<path>. */
  put(path: string, contents: string): Promise<void>;
  /** /workspace/<path>, or undefined when it's missing. */
  get(path: string): Promise<string | undefined>;
  /** Runs a codemode module, and returns what it returned, or the whole result if it failed. */
  run(source: string): Promise<unknown>;
  /** The same, as a read-only agent. */
  runRead(source: string): Promise<unknown>;
  /** Destroys the session's container. */
  destroy(): Promise<void>;
}

export function workspace(name: string): Workspace {
  const url = `${inject("base")}/s/${name}-${Math.random().toString(36).slice(2, 10)}`;
  const ok = async (response: Response) => {
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return response;
  };
  const run = (route: string) => async (source: string) => {
    const response = await ok(await fetch(`${url}/${route}`, { method: "POST", body: source }));
    const result = (await response.json()) as { status: string; exitCode: number; value: unknown };
    return result.status === "completed" && result.exitCode === 0 ? result.value : result;
  };
  return {
    put: async (path, contents) => {
      await ok(await fetch(`${url}/files/${path}`, { method: "PUT", body: contents }));
    },
    get: async (path) => {
      const response = await fetch(`${url}/files/${path}`);
      if (response.status === 404) return undefined;
      return (await ok(response)).text();
    },
    run: run("run"),
    runRead: run("run-read"),
    destroy: async () => {
      await ok(await fetch(url, { method: "DELETE" }));
    },
  };
}
