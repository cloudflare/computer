import { describe, expect, it } from "vitest";

import { isWorkspaceTransportFailure, WorkspaceTransportError } from "./transport-failure.js";

describe("isWorkspaceTransportFailure", () => {
  it("recognises WorkspaceTransportError instances", () => {
    expect(isWorkspaceTransportFailure(new WorkspaceTransportError("nope"))).toBe(true);
  });

  it("recognises capnweb session-closed phrasing", () => {
    expect(
      isWorkspaceTransportFailure(new Error("RPC was canceled because RPC session was shut down")),
    ).toBe(true);
    expect(isWorkspaceTransportFailure(new Error("the RPC session was closed"))).toBe(true);
  });

  it("recognises WebSocket transport failures", () => {
    expect(isWorkspaceTransportFailure(new Error("WebSocket is not open"))).toBe(true);
    expect(isWorkspaceTransportFailure(new Error("WebSocket closed unexpectedly"))).toBe(true);
    expect(isWorkspaceTransportFailure(new Error("socket hang up"))).toBe(true);
  });

  it("recognises container-port unreachable errors", () => {
    expect(isWorkspaceTransportFailure(new Error("connection refused"))).toBe(true);
    expect(isWorkspaceTransportFailure(new Error("ECONNRESET reading from container"))).toBe(true);
  });

  it("recognises heartbeat / watermark failures by their wrapping error", () => {
    const cause = new Error("WebSocket closed");
    const err = new WorkspaceTransportError("heartbeat failed", { cause });
    expect(isWorkspaceTransportFailure(err)).toBe(true);
  });

  it("walks the cause chain", () => {
    const inner = new Error("RPC session was shut down");
    const outer = new Error("watermark sync failed");
    (outer as Error & { cause?: unknown }).cause = inner;
    expect(isWorkspaceTransportFailure(outer)).toBe(true);
  });

  it("returns false for ordinary errors", () => {
    expect(isWorkspaceTransportFailure(new Error("ENOENT: no such file"))).toBe(false);
    expect(isWorkspaceTransportFailure(new Error("command exited with code 1"))).toBe(false);
    expect(isWorkspaceTransportFailure(new Error("permission denied"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isWorkspaceTransportFailure(undefined)).toBe(false);
    expect(isWorkspaceTransportFailure(null)).toBe(false);
    expect(isWorkspaceTransportFailure("WebSocket closed")).toBe(false);
    expect(isWorkspaceTransportFailure(42)).toBe(false);
  });
});
