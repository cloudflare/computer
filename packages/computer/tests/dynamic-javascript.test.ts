import { env } from "cloudflare:workers";

import type { Env, HostDO } from "./dynamic-javascript-worker.js";

// The host's methods as the tests call them. The stub's own RPC types
// are too deep for the type checker to follow here.
interface Host {
  writeFile: HostDO["writeFile"];
  readFile: HostDO["readFile"];
  description(backendId?: string): Promise<string | undefined>;
  run: HostDO["run"];
}

// Each test gets its own host Durable Object, so apps and their storage
// never leak between tests.
function host(): Host {
  const namespace = (env as unknown as Env).HOST;
  // SAFETY: A Durable Object stub forwards these methods to HostDO over RPC.
  return namespace.get(namespace.idFromName(crypto.randomUUID())) as unknown as Host;
}

const COUNTER = `
  import { DurableObject } from "cloudflare:workers";

  export default class Counter extends DurableObject {
    calls = 0;
    increment(by = 1) {
      this.calls += 1;
      const total = (this.ctx.storage.kv.get("total") ?? 0) + by;
      this.ctx.storage.kv.put("total", total);
      return { total, calls: this.calls };
    }
  }
`;

const call = (expression: string) => `
  import Counter from "./counter.js";
  export default async function () {
    return ${expression};
  }
`;

describe("DynamicJavaScriptBackend", () => {
  it("keeps an instance's fields and storage between executions", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    expect((await stub.run(call(`Counter.get("main").increment(2)`))).value).toEqual({
      total: 2,
      calls: 1,
    });
    expect((await stub.run(call(`Counter.get("main").increment(3)`))).value).toEqual({
      total: 5,
      calls: 2,
    });
  });

  it("gives each instance name its own storage", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(
      call(`[
        await Counter.get("a").increment(1),
        await Counter.get("a").increment(1),
        await Counter.get("b").increment(10),
      ].map((entry) => entry.total)`),
    );
    expect(result.value).toEqual([1, 2, 10]);
  });

  it("restarts an instance on new code when its file changes, keeping storage", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    await stub.run(call(`Counter.get("main").increment(4)`));
    await stub.writeFile(
      "/workspace/counter.js",
      COUNTER.replace("return { total, calls: this.calls };", "return { total, version: 2 };"),
    );
    expect((await stub.run(call(`Counter.get("main").increment(1)`))).value).toEqual({
      total: 5,
      version: 2,
    });
  });

  it("restarts on a change to a module the app imports", async () => {
    const stub = host();
    await stub.writeFile("/workspace/lib/label.js", `export const label = "one";`);
    await stub.writeFile(
      "/workspace/labelled.js",
      `
        import { DurableObject } from "cloudflare:workers";
        import { label } from "./lib/label.js";
        export default class extends DurableObject {
          read() { return label; }
        }
      `,
    );
    const read = `import Labelled from "./labelled.js"; export default () => Labelled.get("x").read();`;
    expect((await stub.run(read)).value).toBe("one");
    await stub.writeFile("/workspace/lib/label.js", `export const label = "two";`);
    expect((await stub.run(read)).value).toBe("two");
  });

  it("aborts an instance, dropping its fields and keeping its storage", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(
      call(`[
        await Counter.get("main").increment(1),
        await Counter.get("main").increment(1),
        await Counter.abort("main", "start over"),
        await Counter.get("main").increment(1),
      ]`),
    );
    expect(result.value).toEqual([
      { total: 1, calls: 1 },
      { total: 2, calls: 2 },
      null,
      { total: 3, calls: 1 },
    ]);
  });

  it("deletes an instance with its storage, and leaves the file", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(
      call(`[
        (await Counter.get("main").increment(7)).total,
        await Counter.delete("main"),
        (await Counter.get("main").increment(1)).total,
      ]`),
    );
    expect(result.value).toEqual([7, null, 1]);
    expect(await stub.readFile("/workspace/counter.js")).toBe(COUNTER);
  });

  it("clones an instance's storage over another's", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(
      call(`[
        (await Counter.get("a").increment(5)).total,
        (await Counter.get("b").increment(100)).total,
        await Counter.clone("a", "b"),
        (await Counter.get("b").increment(1)).total,
        (await Counter.get("a").increment(1)).total,
        await Counter.clone("missing", "c"),
        (await Counter.get("c").increment(1)).total,
      ]`),
    );
    expect(result.value).toEqual([5, 100, null, 6, 6, null, 1]);
  });

  it("labels an anonymous app class as App", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/anonymous.js",
      `import { DurableObject } from "cloudflare:workers"; export default class extends DurableObject { hi() { return "anonymous"; } }`,
    );
    const result = await stub.run(`
      import Anonymous from "./anonymous.js";
      export default async () => {
        let unnamed;
        try {
          Anonymous.get("");
        } catch (error) {
          unnamed = error.message;
        }
        return [String(Anonymous.get("x")), await Anonymous.get("x").hi(), unnamed];
      };
    `);
    expect(result.value).toEqual([
      'App instance "x"',
      "anonymous",
      "App.get() takes an instance's name, a non-empty string.",
    ]);
  });

  it("gives an app node:fs, source modules, and host modules inside its methods", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/notes.js",
      `
        import { DurableObject } from "cloudflare:workers";
        import fs from "node:fs/promises";
        import { double } from "math-kit";
        import { echo } from "ws:test-host";

        export default class Notes extends DurableObject {
          async save(text) {
            await fs.writeFile("/workspace/note.txt", text);
            return {
              read: await fs.readFile("/workspace/note.txt", "utf8"),
              doubled: double(text.length),
              host: await echo(text),
            };
          }
        }
      `,
    );
    const result = await stub.run(
      `import Notes from "./notes.js"; export default () => Notes.get("n").save("hello");`,
    );
    expect(result.value).toEqual({ read: "hello", doubled: 10, host: { echoed: ["hello"] } });
    expect(await stub.readFile("/workspace/note.txt")).toBe("hello");
  });

  it("calls the app's own abort and delete methods on an instance", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/job.js",
      `
        import { DurableObject } from "cloudflare:workers";
        export default class Job extends DurableObject {
          abort() { return "own abort"; }
          delete() { return "own delete"; }
        }
      `,
    );
    const result = await stub.run(
      `import Job from "./job.js";
       export default async () => [await Job.get("j").abort(), await Job.get("j").delete()];`,
    );
    expect(result.value).toEqual(["own abort", "own delete"]);
  });

  it("refuses methods that aren't the app's public methods", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/guarded.js",
      `
        import { DurableObject } from "cloudflare:workers";
        export default class Guarded extends DurableObject {
          _secret() { return "secret"; }
          open() { return "open"; }
        }
      `,
    );
    const result = await stub.run(`
      import Guarded from "./guarded.js";
      export default async function () {
        const instance = Guarded.get("g");
        const outcomes = {};
        for (const method of ["_secret", "constructor", "missing", "hasOwnProperty", "fetch", "__workspaceCall", "open"]) {
          try {
            outcomes[method] = await instance[method]();
          } catch (error) {
            outcomes[method] = error.message;
          }
        }
        return outcomes;
      }
    `);
    expect(result.value).toEqual({
      _secret: 'Guarded has no method "_secret" to call.',
      constructor: 'Guarded has no method "constructor" to call.',
      missing: 'Guarded has no method "missing" to call.',
      hasOwnProperty: 'Guarded has no method "hasOwnProperty" to call.',
      fetch: 'Guarded has no method "fetch" to call.',
      __workspaceCall: 'Guarded has no method "__workspaceCall" to call.',
      open: "open",
    });
  });

  it("refuses arguments and results that aren't plain data", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/dates.js",
      `
        import { DurableObject } from "cloudflare:workers";
        export default class extends DurableObject {
          now() { return new Date(0); }
          echo(value) { return value; }
        }
      `,
    );
    const result = await stub.run(`
      import Dates from "./dates.js";
      export default async function () {
        const instance = Dates.get("d");
        const messages = [];
        for (const attempt of [() => instance.now(), () => instance.echo(() => 1)]) {
          try {
            await attempt();
            messages.push("ok");
          } catch (error) {
            messages.push(error.message);
          }
        }
        return messages;
      }
    `);
    expect(result.value).toEqual([
      expect.stringMatching(/plain|JSON/i),
      expect.stringMatching(/plain data/),
    ]);
  });

  it("gives exec code ctx.facets for the app", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(`
      import Counter from "./counter.js";
      export default async function () {
        let constructed;
        try {
          new Counter.constructor();
          constructed = "constructed";
        } catch (error) {
          constructed = error.message;
        }
        let unnamed;
        try {
          Counter.get("");
        } catch (error) {
          unnamed = error.message;
        }
        let detached;
        try {
          const { get } = Counter;
          get("main");
        } catch (error) {
          detached = error.message;
        }
        const instance = await Counter.get("main");
        return {
          kind: Counter.constructor.name,
          tag: Object.prototype.toString.call(Counter),
          methods: Object.getOwnPropertyNames(Object.getPrototypeOf(Counter)),
          constructed,
          unnamed,
          detached,
          awaited: typeof instance.increment,
          printed: String(instance),
          json: JSON.stringify({ instance }),
        };
      }
    `);
    expect(result.value).toEqual({
      kind: "DurableObjectFacets",
      tag: "[object DurableObjectFacets]",
      methods: ["constructor", "get", "abort", "delete", "clone"],
      constructed: "Illegal constructor",
      unnamed: "Counter.get() takes an instance's name, a non-empty string.",
      detached: "Call get() on an app's import, as in Counter.get(...).",
      awaited: "function",
      printed: 'Counter instance "main"',
      json: '{"instance":"Counter instance \\"main\\""}',
    });
  });

  it("imports a Workspace file that isn't an app as an ordinary module", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/plain.js",
      `export default class Plain { greet() { return "local"; } }`,
    );
    const result = await stub.run(
      `import Plain from "./plain.js"; export default () => new Plain().greet();`,
    );
    expect(result.value).toBe("local");
  });

  it("fails a named import from an app", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/helpers.js",
      `
        import { DurableObject } from "cloudflare:workers";
        export const helper = 1;
        export default class extends DurableObject {}
      `,
    );
    const result = await stub.run(
      `import { helper } from "./helpers.js"; export default () => helper;`,
    );
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("helper");
  });

  it("refuses app calls on a read-only backend", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    const result = await stub.run(call(`Counter.get("main").increment(1)`), {
      backend: "read-only",
    });
    expect(result.status).toBe("failed");
    expect(result.stderr).toContain("read-only");
  });

  it("keeps two backends' instances apart", async () => {
    const stub = host();
    await stub.writeFile("/workspace/counter.js", COUNTER);
    await stub.run(call(`Counter.get("main").increment(5)`));
    const second = await stub.run(call(`Counter.get("main").increment(1)`), {
      backend: "second",
    });
    expect(second.value).toEqual({ total: 1, calls: 1 });
  });

  it("fails a call that passes its deadline and leaves the instance usable", async () => {
    const stub = host();
    await stub.writeFile(
      "/workspace/slow.js",
      `
        import { DurableObject } from "cloudflare:workers";
        export default class extends DurableObject {
          async wait(ms) {
            await new Promise((resolve) => setTimeout(resolve, ms));
            this.ctx.storage.kv.put("waited", ms);
            return ms;
          }
          waited() { return this.ctx.storage.kv.get("waited") ?? null; }
        }
      `,
    );
    const timedOut = await stub.run(
      `import Slow from "./slow.js"; export default () => Slow.get("s").wait(800);`,
      { backend: "impatient" },
    );
    expect(timedOut.status).toBe("failed");
    expect(timedOut.stderr).toMatch(/timed out|deadline/);
    const after = await stub.run(
      `
        import Slow from "./slow.js";
        export default async function () {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          return Slow.get("s").waited();
        }
      `,
      { backend: "impatient" },
    );
    expect(after.value).toBe(800);
  });

  it("tells a model about apps in its description", async () => {
    const description = await host().description();
    expect(description).toContain("extends `DurableObject`");
    expect(description).toContain('Counter.get("main")');
    expect(description).toContain("`math-kit`");
  });
});
