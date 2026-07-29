import { describe, expect, it, vi } from "vitest";

import { startHeartbeat } from "./heartbeat.js";

describe("startHeartbeat", () => {
  it("pings on the configured interval", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => {});
      const stop = startHeartbeat({ intervalMs: 1000, ping, onFailure: () => {} });
      // No call until the first interval elapses — heartbeats are
      // periodic, not eager. A backend that wants an immediate
      // probe should do it before kicking off the heartbeat.
      expect(ping).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(ping).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ping).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls onFailure exactly once when ping throws and stops further pings", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const ping = vi.fn(async () => {
        calls++;
        throw new Error("dead peer");
      });
      const onFailure = vi.fn();
      const stop = startHeartbeat({ intervalMs: 1000, ping, onFailure });
      await vi.advanceTimersByTimeAsync(1000);
      // Yield once so the rejected promise's then-handler runs.
      await Promise.resolve();
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][0]).toBeInstanceOf(Error);
      // After failure the heartbeat must not keep ticking — the
      // transport is gone, more pings can't help.
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() prevents future pings", async () => {
    vi.useFakeTimers();
    try {
      const ping = vi.fn(async () => {});
      const stop = startHeartbeat({ intervalMs: 1000, ping, onFailure: () => {} });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ping).toHaveBeenCalledTimes(1);
      stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(ping).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
