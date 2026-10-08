import { describe, expect, it } from "vitest";

import type { ShareOptions } from "../assets/index.js";
import type { WorkspaceModuleCallContext, WorkspaceModuleHost } from "../runtime/types.js";
import { createAssetsModule } from "./assets.js";

function fakeAssets() {
  const calls: Array<{ path: string; options: ShareOptions }> = [];
  return {
    calls,
    client: {
      async share(path: string, options: ShareOptions) {
        calls.push({ path, options });
        return `https://assets.example/${path.split("/").pop()}`;
      },
    },
  };
}

function build(
  assets: ReturnType<typeof fakeAssets>["client"] | undefined,
  options?: Parameters<typeof createAssetsModule>[0],
) {
  // SAFETY: The module only reads host.assets.
  const host = {
    assets,
    git: undefined,
    artifacts: undefined,
    runtime: undefined,
  } as unknown as WorkspaceModuleHost;
  const publish = createAssetsModule(options)(host).publish;
  if (!publish) throw new Error("ws:assets must export publish");
  return publish;
}

function callContext(
  overrides: Partial<WorkspaceModuleCallContext> = {},
): WorkspaceModuleCallContext {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    access: "read",
    resolvePath: async (path) => (path.startsWith("/") ? path : `/workspace/${path}`),
    ...overrides,
  };
}

describe("createAssetsModule", () => {
  it("publishes the resolved path for an hour by default", async () => {
    const { client, calls } = fakeAssets();
    const publish = build(client);

    await expect(publish(["out/report.pdf"], callContext())).resolves.toBe(
      "https://assets.example/report.pdf",
    );
    expect(calls).toEqual([
      { path: "/workspace/out/report.pdf", options: { expiresAfter: 60 * 60 * 1000 } },
    ]);
  });

  it("accepts milliseconds or a duration, and the share options", async () => {
    const { client, calls } = fakeAssets();
    const publish = build(client);

    await publish(["/workspace/a.txt", { expiresAfter: 5000 }], callContext());
    await publish(
      [
        "/workspace/b.txt",
        {
          expiresAfter: "2h30m",
          filename: "b.csv",
          disposition: "attachment",
          contentType: "text/csv",
        },
      ],
      callContext(),
    );
    expect(calls.map((call) => call.options)).toEqual([
      { expiresAfter: 5000 },
      {
        expiresAfter: 9_000_000,
        filename: "b.csv",
        disposition: "attachment",
        contentType: "text/csv",
      },
    ]);
  });

  it("uses the configured default expiry", async () => {
    const { client, calls } = fakeAssets();
    const publish = build(client, { defaultExpiresAfterMs: 1000 });

    await publish(["a.txt", null], callContext());
    expect(calls[0]?.options).toEqual({ expiresAfter: 1000 });
  });

  it.each([
    [[], /takes a path/],
    [[""], /non-empty string/],
    [["a.txt", "1h"], /options must be an object/],
    [["a.txt", { expires: "1h" }], /unknown option "expires"/],
    [["a.txt", { expiresAfter: -1 }], /positive number/],
    [["a.txt", { expiresAfter: "soon" }], /not a duration/],
    [["a.txt", { expiresAfter: true }], /number of milliseconds or a duration/],
    [["a.txt", { disposition: "download" }], /inline" or "attachment/],
    [["a.txt", { filename: 1 }], /filename must be a string/],
  ])("rejects %j", async (args, message) => {
    const { client, calls } = fakeAssets();
    const publish = build(client);

    await expect(publish(args as never, callContext())).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it("does not publish once the call is cancelled", async () => {
    const { client, calls } = fakeAssets();
    const publish = build(client);
    const abort = new AbortController();
    abort.abort();

    await expect(publish(["a.txt"], callContext({ signal: abort.signal }))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("fails to connect without an assets client", () => {
    expect(() => build(undefined)).toThrow(/no assets client/);
  });

  it("rejects a non-positive default expiry", () => {
    expect(() => createAssetsModule({ defaultExpiresAfterMs: 0 })).toThrow(/positive/);
  });

  it("describes itself", () => {
    expect(createAssetsModule().description).toContain("publish(path");
  });
});
