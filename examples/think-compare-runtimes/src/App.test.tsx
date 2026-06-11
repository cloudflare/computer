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

  test("renders the idle instrument cluster with task metadata and two runtime wings", () => {
    vi.stubGlobal("fetch", vi.fn());

    render(<App />);

    expect(screen.getByText("THINK · RUNTIME COMPARE")).toBeTruthy();
    expect(screen.getByText("TASK")).toBeTruthy();
    expect(screen.getByRole("button", { name: "START RUN" })).toBeTruthy();
    expect(screen.getByText(/Add documentation for Smart Request Policies/)).toBeTruthy();

    const workspace = screen.getByLabelText("Workspace runtime wing");
    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(workspace).getByText("L · WORKSPACE")).toBeTruthy();
    expect(within(workspace).getByText("@cloudflare/workspace")).toBeTruthy();
    expect(within(workspace).getByText("Durable files + routed exec")).toBeTruthy();
    expect(
      within(workspace).getByText(
        "Direct file tools use durable storage. Exec routes to the worker shell first, then container for real binaries.",
      ),
    ).toBeTruthy();
    expect(within(workspace).getByText("Shell")).toBeTruthy();
    expect(within(workspace).getByText("Container")).toBeTruthy();
    expect(within(workspace).getByText("asleep")).toBeTruthy();
    expect(within(workspace).getByText("◇ planned · seeds into DOFS on run start")).toBeTruthy();

    expect(within(sandbox).getByText("R · SANDBOX")).toBeTruthy();
    expect(within(sandbox).getByText("@cloudflare/sandbox")).toBeTruthy();
    expect(within(sandbox).getByText("Container filesystem")).toBeTruthy();
    expect(
      within(sandbox).getByText(
        "Same fixture is seeded into the Sandbox filesystem. File tools and exec run there.",
      ),
    ).toBeTruthy();
    expect(within(sandbox).getByText("Container")).toBeTruthy();
  });

  test("starts a comparison run from the top bar", async () => {
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
              timestamp: "2026-06-04T00:00:00.000Z",
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
    expect(await screen.findByText(/^RUN · /)).toBeTruthy();
    expect(screen.getByText("run-123")).toBeTruthy();
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

    expect(screen.getByText("RUN · 00:00")).toBeTruthy();

    act(() => {
      vi.setSystemTime(new Date("2026-06-04T00:00:01.000Z"));
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("RUN · 00:02")).toBeTruthy();
    expect(within(screen.getByLabelText("Workspace runtime wing")).getByText("Files")).toBeTruthy();
  });

  test("renders telemetry and grouped activity for live runtime events", async () => {
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
          title: "Workspace runtime started",
          timestamp: "2026-06-04T00:00:01.000Z",
        }),
        event({
          sequence: 2,
          runtime: "workspace",
          kind: "tool_call",
          title: "read called",
          detail: JSON.stringify({ path: "/workspace/repo/src/policy.ts" }),
          timestamp: "2026-06-04T00:00:02.000Z",
        }),
        event({
          sequence: 3,
          runtime: "workspace",
          kind: "agent_message",
          title: "Workspace response",
          detail: "I found the policy helper.",
          timestamp: "2026-06-04T00:00:03.000Z",
        }),
        event({
          sequence: 4,
          runtime: "sandbox",
          kind: "runtime_started",
          title: "Sandbox runtime started",
          timestamp: "2026-06-04T00:00:04.000Z",
        }),
        event({
          sequence: 5,
          runtime: "sandbox",
          kind: "agent_tool_call",
          title: "Think requested exec",
          detail: JSON.stringify({ command: "npm test", cwd: "/workspace/repo" }),
          timestamp: "2026-06-04T00:00:05.000Z",
        }),
      ]),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    await screen.findByText("read called");
    const workspace = screen.getByLabelText("Workspace runtime wing");
    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(workspace).getByText("Files")).toBeTruthy();
    expect(within(workspace).getByText("1")).toBeTruthy();
    expect(within(workspace).getByText("Shell")).toBeTruthy();
    expect(within(workspace).getByText("0")).toBeTruthy();
    expect(within(workspace).getByText("asleep")).toBeTruthy();
    expect(within(workspace).getByText("I found the policy helper.")).toBeTruthy();
    expect(within(workspace).getByText("read called")).toBeTruthy();

    expect(within(sandbox).getByText("Container")).toBeTruthy();
    expect(within(sandbox).getAllByText("1").length).toBeGreaterThanOrEqual(1);
    expect(within(sandbox).getByText("Think requested exec")).toBeTruthy();
    expect(within(sandbox).getByText("npm test")).toBeTruthy();
  });

  test("renders assistant response details as Markdown", async () => {
    vi.stubGlobal(
      "fetch",
      sessionWithEvents([
        event({
          sequence: 0,
          runtime: "workspace",
          kind: "agent_message",
          title: "Think turn complete",
          detail:
            "## Summary of Changes\n\nI modified `src/index.ts`.\n\n1. **Empty array handling**: Added a guard.\n2. **Consistent decimal formatting**: Used `toFixed(1)`.\n\n### Runtime Observations\n\n- `npm test` passed.\n- No dependencies were needed.",
          timestamp: "2026-06-04T00:00:03.000Z",
        }),
      ]),
    );

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "START RUN" }));

    const workspace = await screen.findByLabelText("Workspace runtime wing");
    expect(within(workspace).getByRole("heading", { name: "Summary of Changes" })).toBeTruthy();
    expect(within(workspace).getByRole("heading", { name: "Runtime Observations" })).toBeTruthy();
    expect(within(workspace).getByText("src/index.ts")).toBeTruthy();
    expect(within(workspace).getByText("Empty array handling")).toBeTruthy();
    expect(within(workspace).getByText("npm test")).toBeTruthy();
  });

  test("renders completed run telemetry and capacity failure hints", async () => {
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

    expect(await screen.findByText("FAILED · 03:42")).toBeTruthy();
    expect(screen.getByRole("button", { name: "RUN AGAIN" })).toBeTruthy();

    const workspace = screen.getByLabelText("Workspace runtime wing");
    const sandbox = screen.getByLabelText("Sandbox runtime wing");

    expect(within(workspace).getByText(/done/)).toBeTruthy();
    expect(within(workspace).getByText("Files")).toBeTruthy();
    expect(within(workspace).getByText("Check")).toBeTruthy();
    expect(within(sandbox).getByText(/failed/)).toBeTruthy();
    expect(within(sandbox).getByText("Elapsed")).toBeTruthy();
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
