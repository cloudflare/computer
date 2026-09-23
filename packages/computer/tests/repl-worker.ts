// Test host for durable REPL sessions — the core eval loop.
//
// The DO is the session host by necessity: a plain worker cannot hold
// loader entrypoint stubs across per-request I/O contexts. `restart()`
// simulates a Durable Object eviction by rebuilding the Workspace over the
// same storage — exactly what a real restart does.

import { DurableObject } from "cloudflare:workers";
import type {
  DurableObjectStorageLike,
  ReplCapability,
  ReplEvalOptions,
  ReplExecutionResult,
} from "../src/index.js";
import { capability, fetchCapability, Workspace, workspaceFs } from "../src/index.js";

export interface Env {
  HOST: DurableObjectNamespace<ReplHostDO>;
  LOADER: WorkerLoader;
  SELF: Fetcher;
}

// A page handle vended by the browser fixture: methods live on the
// prototype, exactly like a real SDK class.
class TabFixture {
  readonly #url: string;
  readonly #count: (name: string) => void;

  constructor(url: string, count: (name: string) => void) {
    this.#url = url;
    this.#count = count;
  }

  read(): { url: string; title: string } {
    this.#count("tab.read");
    return { url: this.#url, title: `Title of ${this.#url}` };
  }

  click(selector: string): { clicked: string } {
    this.#count("tab.click");
    return { clicked: selector };
  }
}

class BrowserFixture {
  readonly #count: (name: string) => void;

  constructor(count: (name: string) => void) {
    this.#count = count;
  }

  newTab(url: string): TabFixture {
    this.#count("browser.newTab");
    return new TabFixture(url, this.#count);
  }
}

export class ReplHostDO extends DurableObject<Env> {
  #workspace: Workspace | undefined;
  // Live-call counters for capability fixtures. On the DO (not the
  // Workspace) so restart() keeps them — they count real side effects,
  // which survive process boundaries in the world too.
  #counts: Record<string, number> = {};

  #ws(): Workspace {
    this.#workspace ??= new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    });
    return this.#workspace;
  }

  #count(name: string): void {
    this.#counts[name] = (this.#counts[name] ?? 0) + 1;
  }

  // Capability fixtures, built fresh per attachment like a real host
  // would. A fixture id maps to [global name, capability] so two fixtures
  // (configV1/configV2) can grant the same name with different values.
  #fixtures(names: string[]): Record<string, ReplCapability> {
    const count = (name: string) => this.#count(name);
    const available: Record<string, () => [string, ReplCapability]> = {
      weather: () => [
        "weather",
        capability(
          {
            get: (city: string) => {
              count("weather.get");
              return { city, temp: 21.5, asOf: new Date(1735732800000) };
            },
            flaky: () => {
              count("weather.flaky");
              throw new Error(`boom ${this.#counts["weather.flaky"]}`);
            },
          },
          {
            description: "Weather lookups",
            docs: { get: "get(city) → { city, temp, asOf }" },
          },
        ),
      ],
      sendEmail: () => [
        "sendEmail",
        capability((to: string, subject: string) => {
          count("sendEmail");
          return { queued: true, id: `msg-${this.#counts.sendEmail}`, to, subject };
        }),
      ],
      browser: () => ["browser", capability(new BrowserFixture(count))],
      // Nested callable surface (children) beside plain data.
      api: () => [
        "api",
        capability({
          version: "2.0",
          users: {
            list: () => {
              count("api.users.list");
              return ["ada", "grace"];
            },
          },
        }),
      ],
      // Unreflectable surface — properties materialize on access, like an
      // RPC stub. The runner must treat every property as a method.
      stub: () => [
        "stub",
        capability(
          new Proxy(
            {},
            {
              get: (_target, prop) =>
                prop === "ping"
                  ? () => {
                      count("stub.ping");
                      return "pong";
                    }
                  : undefined,
              getPrototypeOf: () => null,
            },
          ) as object,
        ),
      ],
      // A method that returns a bare function — minted as a callable handle.
      tools: () => [
        "tools",
        capability({
          makeGreeter: (name: string) => {
            count("tools.makeGreeter");
            return (greeting: string) => {
              count("tools.greet");
              return `${greeting}, ${name}!`;
            };
          },
        }),
      ],
      configV1: () => [
        "config",
        capability({ apiUrl: "https://v1.example", retries: 1 }),
      ],
      configV2: () => [
        "config",
        capability({ apiUrl: "https://v2.example", retries: 5 }),
      ],
      fs: () => ["fs", workspaceFs({ fs: this.#countingFs() })],
      fetchBlocked: () => ["fetch", fetchCapability({ allow: ["allowed.example"] })],
      fetchSelf: () => [
        "fetch",
        fetchCapability({
          fetch: (url: string, init?: RequestInit) => {
            count("gateway.fetch");
            return this.env.SELF.fetch(url, init);
          },
        }),
      ],
      big: () => [
        "big",
        capability({
          blob: (n: number) => {
            count("big.blob");
            return "x".repeat(n);
          },
        }),
      ],
    };
    const grants: Record<string, ReplCapability> = {};
    for (const name of names) {
      const build = available[name];
      if (!build) throw new Error(`Unknown capability fixture: ${name}`);
      const [globalName, grant] = build();
      grants[globalName] = grant;
    }
    return grants;
  }

  // The workspace filesystem with live-call counting on every method,
  // proving replay never re-fires filesystem effects. `this`-preserving
  // delegation (private fields inside WorkspaceFilesystem).
  #countingFs(): Workspace["fs"] {
    const fs = this.#ws().fs;
    const count = (name: string) => this.#count(name);
    return new Proxy(fs, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          count(`fs.${String(prop)}`);
          return (value as (...call: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }

  counts(): Record<string, number> {
    return this.#counts;
  }

  async replEvalWith(
    fixtures: string[],
    session: string,
    code: string,
    options?: ReplEvalOptions,
    sessionOptions?: { maxEffectBytes?: number },
  ): Promise<ReplExecutionResult> {
    return this.#ws()
      .repl(session, {
        loader: this.env.LOADER,
        capabilities: this.#fixtures(fixtures),
        ...sessionOptions,
      })
      .eval(code, options);
  }

  async replEval(
    session: string,
    code: string,
    options?: ReplEvalOptions,
  ): Promise<ReplExecutionResult> {
    return this.#ws().repl(session, { loader: this.env.LOADER }).eval(code, options);
  }

  // Simulate DO eviction: drop every in-memory object. Storage survives.
  restart(): void {
    this.#workspace = undefined;
  }

  // Fire two evals concurrently inside the DO (bypasses input-gate
  // serialization of separate RPC calls) to exercise the session's
  // internal eval queue.
  async replEvalPair(
    session: string,
    codeA: string,
    codeB: string,
  ): Promise<[ReplExecutionResult, ReplExecutionResult]> {
    const repl = this.#ws().repl(session, { loader: this.env.LOADER });
    const [a, b] = await Promise.all([repl.eval(codeA), repl.eval(codeB)]);
    return [a, b];
  }

  // Corrupt the durable log out from under the session (divergence tests).
  corruptEffectKinds(session: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE repl_effects SET kind = 'corrupted' WHERE session = ?",
      session,
    );
  }

  injectExtraEffect(session: string, cellSeq: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO repl_effects (session, cell_seq, call_seq, kind, value)
       VALUES (?, ?, 999, 'random', '{"v":0.5}')`,
      session,
      cellSeq,
    );
  }

  // Rewrite recorded capability-call text (args live inside the call
  // identity), simulating a log whose recorded args no longer match code.
  corruptCapCallArgs(session: string, from: string, to: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE repl_effects SET value = replace(value, ?, ?) WHERE session = ? AND kind = 'cap'",
      from,
      to,
      session,
    );
  }
}

export default {
  // Doubles as the gateway target for fetchSelf: returns canned JSON so
  // fetch-capability tests need no real network.
  fetch(request: Request): Response {
    return Response.json({ ok: true, path: new URL(request.url).pathname });
  },
};
