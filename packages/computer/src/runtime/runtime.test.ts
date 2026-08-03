import { describe, expect, it, vi } from "vitest";

import { WorkspaceRuntime } from "./runtime.js";
import type { ModuleExecutionEnvelope, WorkspaceModuleBackendHandle } from "./types.js";

function emptyEnvelope(id: string): ModuleExecutionEnvelope {
  return {
    id,
    events: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

function moduleHandleStub(): WorkspaceModuleBackendHandle {
  return {
    exec: vi.fn(async (input) => emptyEnvelope(input.id ?? "exec")),
    getExec: vi.fn(async (input) => emptyEnvelope(input.id)),
    killExec: vi.fn(async () => {}),
    disposeExec: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

describe("WorkspaceRuntime callable gate", () => {
  it("rejects structured input for a non-callable backend", async () => {
    const runtime = new WorkspaceRuntime({
      callableBackendIds: new Set(),
      backendHandle: async () => moduleHandleStub(),
      resolveBackendId: () => "worker-shell",
    });

    await expect(
      runtime.exec("echo hi", { backend: "worker-shell", input: { n: 1 } }),
    ).rejects.toThrow(/not callable/);
  });

  it("accepts structured input for a callable module backend", async () => {
    const handle = moduleHandleStub();
    const runtime = new WorkspaceRuntime({
      callableBackendIds: new Set(["worker-javascript"]),
      backendHandle: async () => handle,
      resolveBackendId: () => "worker-javascript",
    });

    await runtime.exec("export default (i) => i", {
      backend: "worker-javascript",
      input: { n: 1 },
    });

    expect(handle.exec).toHaveBeenCalledWith(expect.objectContaining({ input: { n: 1 } }));
  });
});
