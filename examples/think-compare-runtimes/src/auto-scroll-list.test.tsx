// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AutoScrollList } from "./auto-scroll-list";

describe("AutoScrollList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("scrolls to the bottom when its watch key changes", () => {
    const scrollTo = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(480);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    const { rerender } = render(
      <AutoScrollList ariaLabel="Workspace activity stream" className="stream" watchKey={1}>
        <li>first event</li>
      </AutoScrollList>,
    );

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: "smooth" });

    rerender(
      <AutoScrollList ariaLabel="Workspace activity stream" className="stream" watchKey={2}>
        <li>first event</li>
        <li>second event</li>
      </AutoScrollList>,
    );

    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: "smooth" });
  });

  test("keeps separate lists independently scrollable", () => {
    const scrollTo = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(320);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    render(
      <div>
        <AutoScrollList ariaLabel="Workspace activity stream" className="stream" watchKey={1}>
          <li>workspace event</li>
        </AutoScrollList>
        <AutoScrollList ariaLabel="Sandbox activity stream" className="stream" watchKey={1}>
          <li>sandbox event</li>
        </AutoScrollList>
      </div>,
    );

    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo.mock.contexts[0]).not.toBe(scrollTo.mock.contexts[1]);
  });
});
