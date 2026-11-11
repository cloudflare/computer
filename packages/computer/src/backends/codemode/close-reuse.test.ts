import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { unsafeToRepeat } from "../../runtime/replay-safety";
import { Workspace } from "../../workspace";
import { CodemodeBackend } from "./codemode";

// Workspace.close() drops its module handle at once and cancels the
// handle's runs after that. A request that reaches the Workspace in
// between must not open a second handle that treats those runs as
// interrupted and starts them again beside the first.

function closeAndReuse(
  wrap: (fn: () => Promise<null>) => () => Promise<null>,
  storage = new SQLiteTestStorage(),
) {
  let calls = 0;
  let launches = 0;
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Each launch makes one host call, then hangs.
  const loader = {
    load() {
      return {
        getEntrypoint() {
          return {
            async evaluate(
              _input: unknown,
              host: { call(name: string, args: unknown[]): Promise<unknown> },
            ) {
              launches += 1;
              await host.call("host/codemode:test.charge", []);
              await new Promise<void>(() => undefined);
            },
          };
        },
      };
    },
  };
  const charge = wrap(async () => {
    calls += 1;
    await slow;
    return null;
  });
  const ws = new Workspace({
    storage,
    backends: [
      new CodemodeBackend({
        loader,
        onInterrupt: "replay",
        modules: { "codemode:test": { charge } },
      } as ConstructorParameters<typeof CodemodeBackend>[0]),
    ],
  });
  return {
    ws,
    release,
    counts: () => ({ calls, launches }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("CodemodeBackend across Workspace.close() and reuse", () => {
  it("does not run a call again when the Workspace is used while it closes", async () => {
    const run = closeAndReuse((fn) => fn);
    await run.ws.fs.mkdir("/workspace", { recursive: true });
    await run.ws.runtime.exec("export default 1", { backend: "codemode", id: "run" });
    await settle();
    expect(run.counts()).toEqual({ calls: 1, launches: 1 });

    // close() starts; another request reaches the Workspace meanwhile.
    const closing = run.ws.close();
    const reopened = run.ws.ready("codemode");
    await settle();
    run.release();
    await closing;
    await reopened;
    await settle();

    expect(run.counts()).toEqual({ calls: 1, launches: 1 });
    const result = await (
      await run.ws.runtime.getExec("run", { backend: "codemode", encoding: "utf8" })
    ).result();
    expect(result.status).toBe("cancelled");
  });

  it("does not report an unsafe call interrupted when nothing restarted", async () => {
    const run = closeAndReuse((fn) => unsafeToRepeat(fn));
    await run.ws.fs.mkdir("/workspace", { recursive: true });
    await run.ws.runtime.exec("export default 1", { backend: "codemode", id: "run" });
    await settle();

    const closing = run.ws.close();
    const reopened = run.ws.ready("codemode");
    await settle();
    run.release();
    await closing;
    await reopened;
    await settle();

    const result = await (
      await run.ws.runtime.getExec("run", { backend: "codemode", encoding: "utf8" })
    ).result();
    expect(result.status).toBe("cancelled");
    expect(result.stderr).not.toContain("isn't safe to repeat");
  });

  it("does not run a call again when close() lands while the backend is connecting", async () => {
    // A run left running by a previous incarnation of the object, whose
    // loader never returned. Connecting relaunches it.
    const storage = new SQLiteTestStorage();
    const earlier = new Workspace({
      storage,
      backends: [
        new CodemodeBackend({
          onInterrupt: "replay",
          loader: {
            load: () => ({
              getEntrypoint: () => ({ evaluate: () => new Promise<void>(() => undefined) }),
            }),
          },
        }),
      ],
    });
    await earlier.fs.mkdir("/workspace", { recursive: true });
    await earlier.runtime.exec("export default 1", { backend: "codemode", id: "run" });

    const run = closeAndReuse((fn) => fn, storage);
    // The connect starts, close() lands before it settles, and another
    // request connects again while that handle is still closing.
    const connecting = run.ws.runtime.recover().catch(() => undefined);
    const closing = run.ws.close();
    const reopened = run.ws.ready("codemode");
    await settle();
    run.release();
    await Promise.all([connecting, closing, reopened]);
    await settle();

    expect(run.counts()).toEqual({ calls: 1, launches: 1 });
    await earlier.close();
  });
});
