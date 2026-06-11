// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

vi.mock("partysocket/react", () => ({
  usePartySocket: vi.fn(),
}));

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("renders a clean idle substrate instrument", () => {
    vi.stubGlobal("fetch", vi.fn());

    render(<App />);

    expect(screen.getByText("Workspace / Sandbox")).toBeTruthy();
    expect(screen.queryByText("Workspace vs Sandbox · same task · same model")).toBeNull();
    expect(screen.queryByText("TASK")).toBeNull();
    expect(screen.queryByText(/run-/)).toBeNull();
    expect(screen.getByRole("button", { name: "START RUN" })).toBeTruthy();

    const workspace = screen.getByLabelText("Workspace runtime wing");
    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(workspace).getByText("Workspace")).toBeTruthy();
    expect(within(workspace).queryByText("VFS · dynamic worker · container escalation")).toBeNull();
    expect(within(workspace).getAllByText("VFS").length).toBeGreaterThanOrEqual(1);
    expect(within(workspace).getAllByText("Dynamic worker").length).toBeGreaterThanOrEqual(1);
    expect(within(workspace).getAllByText("Container").length).toBeGreaterThanOrEqual(1);
    expect(within(workspace).queryByText("Routing summary")).toBeNull();
    expect(within(workspace).queryByText("Details")).toBeNull();
    expect(within(workspace).queryByText("Check")).toBeNull();

    expect(within(sandbox).getAllByText("Sandbox").length).toBeGreaterThanOrEqual(1);
    expect(within(sandbox).queryByText("Container-native files and commands")).toBeNull();
  });

  test("starts a comparison run without exposing debug run IDs", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          runId: "run-123",
          socketPath: "/parties/compare-run/run-123",
          events: [
            event({
              id: "run-123:0",
              runId: "run-123",
              sequence: 0,
              runtime: "both",
              kind: "run_started",
              title: "Comparison run started",
              detail: "Both agents are starting.",
              timestamp: new Date().toISOString(),
            }),
          ],
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/runs", { method: "POST" }));
    expect(screen.queryByText("run-123")).toBeNull();
    expect((screen.getByRole("button", { name: "STOP RUN" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("stops and discards the visible run so a new run can start", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/runs/run-123/stop") {
        return new Response(null, { status: 204 });
      }
      return Response.json(
        {
          runId: "run-123",
          socketPath: "/parties/compare-run/run-123",
          events: [
            event({
              id: "run-123:0",
              runId: "run-123",
              sequence: 0,
              runtime: "both",
              kind: "run_started",
              timestamp: new Date().toISOString(),
            }),
          ],
        },
        { status: 201 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));
    const stopButton = await screen.findByRole("button", { name: "STOP RUN" });

    fireEvent.click(stopButton);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-123/stop", { method: "POST" }),
    );
    expect(screen.getByRole("button", { name: "START RUN" })).toBeTruthy();
    expect(screen.queryByText(/Running ·/)).toBeNull();
  });

  test("updates running elapsed time before agents finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      sessionWithEvents([
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
      ]),
    );

    render(<App />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "START RUN" }));
      await Promise.resolve();
    });

    act(() => {
      vi.setSystemTime(new Date("2026-06-04T00:00:01.000Z"));
      vi.advanceTimersByTime(1000);
    });

    expect(
      within(screen.getByLabelText("Workspace runtime wing")).getByText(/Running · 00:02/i),
    ).toBeTruthy();
  });

  test("renders substrate lanes and streamed thinking without raw event details", async () => {
    vi.stubGlobal(
      "fetch",
      sessionWithEvents([
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 2,
          runtime: "workspace",
          kind: "agent_tool_call",
          title: "Think requested read",
          detail: JSON.stringify({ path: "/workspace/repo/docs/workers/security.md" }),
          timestamp: "2026-06-04T00:00:02.000Z",
        }),
        event({
          sequence: 3,
          runtime: "workspace",
          kind: "agent_message_delta",
          title: "Think response stream",
          detail: "Reading the related docs before editing.",
          timestamp: "2026-06-04T00:00:03.000Z",
        }),
        event({
          sequence: 4,
          runtime: "workspace",
          kind: "agent_tool_result",
          title: "Think exec result",
          detail: JSON.stringify({
            command: "grep -R Smart docs",
            cwd: "/workspace/repo",
            executionTarget: "worker-shell",
            exitCode: 0,
            stdout: "docs/workers/security.md:Smart Request Policies",
            stderr: "",
          }),
          timestamp: "2026-06-04T00:00:05.000Z",
        }),
        event({
          sequence: 5,
          runtime: "sandbox",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 6,
          runtime: "sandbox",
          kind: "agent_tool_result",
          title: "Think exec result",
          detail: JSON.stringify({
            command: "npm run check",
            cwd: "/workspace/repo",
            executionTarget: "sandbox-container",
            exitCode: 0,
            stdout: "docs check passed",
            stderr: "",
          }),
          timestamp: "2026-06-04T00:00:06.000Z",
        }),
      ]),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    const workspace = await screen.findByLabelText("Workspace runtime wing");
    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(workspace).getByLabelText("workspace substrate timeline")).toBeTruthy();
    expect(
      await within(workspace).findByText("Reading the related docs before editing."),
    ).toBeTruthy();
    const workspaceStream = within(workspace).getByLabelText("workspace agent work stream");
    expect(workspaceStream.className).toContain("overflow-y-auto");
    expect(within(workspace).getAllByText("Dynamic worker").length).toBeGreaterThanOrEqual(1);
    expect(within(workspace).getByText("$ grep -R Smart docs")).toBeTruthy();
    expect(within(workspace).getAllByText("dynamic worker").length).toBeGreaterThanOrEqual(1);
    expect(within(workspace).getByText("exit 0")).toBeTruthy();
    expect(within(workspace).queryByText("message")).toBeNull();
    expect(within(workspace).queryByText("Command requested")).toBeNull();
    expect(within(workspace).getAllByText("1").length).toBeGreaterThanOrEqual(2);
    expect(within(workspace).queryByText("Routing summary")).toBeNull();
    expect(within(workspace).queryByText("agent · tool · result")).toBeNull();

    expect(within(sandbox).getByLabelText("sandbox substrate timeline")).toBeTruthy();
    expect(within(sandbox).getAllByText("Sandbox").length).toBeGreaterThanOrEqual(1);
    expect(within(sandbox).getByText("exit 0")).toBeTruthy();
    expect(within(sandbox).queryByText("Check")).toBeNull();
    expect(within(sandbox).queryByText("State")).toBeNull();
  });

  test("renders assistant response details as Markdown in the secondary transcript", async () => {
    vi.stubGlobal(
      "fetch",
      sessionWithEvents([
        event({
          sequence: 0,
          runtime: "workspace",
          kind: "agent_message",
          title: "Think turn complete",
          detail:
            "## Summary of Changes\n\nI modified `docs/workers/smart-request-policies.md`.\n\n- `npm run check` passed.",
          timestamp: "2026-06-04T00:00:03.000Z",
        }),
      ]),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    const workspace = await screen.findByLabelText("Workspace runtime wing");
    expect(within(workspace).getByRole("heading", { name: "Summary of Changes" })).toBeTruthy();
    expect(within(workspace).getByText("docs/workers/smart-request-policies.md")).toBeTruthy();
    expect(within(workspace).getByText("npm run check")).toBeTruthy();
  });

  test("renders completed run status and capacity failure hints", async () => {
    vi.stubGlobal(
      "fetch",
      sessionWithEvents([
        event({
          sequence: 0,
          runtime: "both",
          kind: "run_started",
          timestamp: "2026-06-04T00:00:00.000Z",
        }),
        event({
          sequence: 1,
          runtime: "workspace",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 2,
          runtime: "workspace",
          kind: "runtime_completed",
          title: "Workspace runtime completed",
          timestamp: "2026-06-04T00:02:51.000Z",
        }),
        event({
          sequence: 3,
          runtime: "sandbox",
          kind: "runtime_started",
          timestamp: "2026-06-04T00:00:02.000Z",
        }),
        event({
          sequence: 4,
          runtime: "sandbox",
          kind: "runtime_failed",
          title: "Sandbox runtime failed",
          detail: "3040: Capacity temporarily exceeded, please try again.",
          timestamp: "2026-06-04T00:03:42.000Z",
        }),
        event({
          sequence: 5,
          runtime: "both",
          kind: "run_completed",
          title: "Comparison run complete",
          timestamp: "2026-06-04T00:03:42.000Z",
        }),
      ]),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    expect(
      await within(screen.getByLabelText("Workspace runtime wing")).findByText(
        /Completed · 02:50/i,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "RUN AGAIN" })).toBeTruthy();

    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(sandbox).getByText(/Failed · 03:40/i)).toBeTruthy();
    expect(within(sandbox).getByText("Upstream model capacity; retry later.")).toBeTruthy();
  });
});

function sessionWithEvents(events: ReturnType<typeof event>[]) {
  return vi.fn(async () =>
    Response.json(
      {
        runId: "run-456",
        socketPath: "/parties/compare-run/run-456",
        events,
      },
      { status: 201 },
    ),
  );
}

function event(overrides: Partial<import("../shared/events").RunEvent>) {
  return {
    id: `run-1:${overrides.sequence ?? 0}`,
    runId: "run-1",
    sequence: overrides.sequence ?? 0,
    runtime: overrides.runtime ?? "both",
    kind: overrides.kind ?? "run_started",
    title: overrides.title ?? "Event",
    detail: overrides.detail ?? "Detail",
    timestamp: overrides.timestamp ?? "1970-01-01T00:00:00.000Z",
    ...overrides,
  } as import("../shared/events").RunEvent;
}
