// Tests for `createGitClient` — the workspace-bound entry point.
//
// The wrapping is thin: build an FsClient from `ws.provider()`
// once, hand it to `cloneWith` / `diffWith` on each call. The
// behaviour of those two is covered by clone.test.ts and
// diff.test.ts; what's worth pinning here is the binding contract.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";
import { describe, expect, it, vi } from "vitest";

import type { IsomorphicGitFSClient } from "./adapter.js";
import { createGitClient } from "./index.js";

// `createGitClient` only reads `.provider()` and forwards the
// result to the adapter. A stub provider is enough; the adapter
// itself is exercised by its own integration path.
const opaqueProvider = {} as unknown as SQLiteWorkspaceProvider;

function stubFs(): IsomorphicGitFSClient {
  return {
    promises: {
      readFile: vi.fn(async () => new Uint8Array()),
    },
  };
}

describe("createGitClient", () => {
  it("calls ws.provider() lazily on first use, then caches the FsClient", async () => {
    const provider = vi.fn(() => opaqueProvider);
    const fs = stubFs();
    const adapter = vi.fn(async () => fs);

    const client = createGitClient({ ws: { provider }, adapter });

    // No work happens at construction time.
    expect(provider).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();

    // First op fails (the fake fs/git layer below isomorphic-git
    // can't service a real clone) — but provider/adapter are
    // observed before the failure.
    await client.clone({ url: "https://example.test/repo.git" }).catch(() => {});
    expect(provider).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledWith(opaqueProvider);

    // A second op reuses the cached FsClient — neither provider
    // nor adapter is invoked again.
    await client.diff().catch(() => {});
    expect(provider).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
