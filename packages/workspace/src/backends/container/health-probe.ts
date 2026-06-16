// Shared wsd health probe.
//
// Used in two places that must agree on what "healthy" means:
//
//   - CloudflareContainerBackend.connect() startup readiness, in
//     place of the previous private #waitForPort loop;
//   - the keep-alive alarm's lease-time check.
//
// A single HEAD against the configured healthPath on the container
// port. ctx.container.running tells the runtime the container is
// attached, not that wsd is listening; this probe closes the gap.
//
// Probe failures bubble out as rejections; callers apply their own
// backoff / budget. No retries here — keeping the helper a single
// shot lets startup and lease alarms compose it differently.

import type { IWorkspaceContainerAPI } from "./container-host.js";

export interface WsdHealthProbeOptions {
  // TCP port wsd listens on inside the container.
  port: number;
  // Path to probe. Defaults to /health at the call site; required
  // here so both callers thread the same value.
  path: string;
  // Per-probe timeout. The helper aborts the request when it
  // elapses; the host's fetchPort surfaces that as a rejection.
  timeoutMs: number;
}

export async function probeWsdHealth(
  host: IWorkspaceContainerAPI,
  options: WsdHealthProbeOptions,
): Promise<void> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  const res = await host.fetchPort(options.port, `http://container${options.path}`, {
    method: "HEAD",
    signal,
  });
  // Drain the body so the underlying connection (if any) can be
  // released. Some runtimes return a non-null body for HEAD even
  // though it should be empty; cancel() is a no-op for null.
  void res.body?.cancel();
  if (!res.ok) {
    throw new Error(`wsd health returned ${res.status}`);
  }
}
