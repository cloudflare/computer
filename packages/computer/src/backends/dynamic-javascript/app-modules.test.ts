import { durableObjectClassName } from "./app-modules.js";

describe("durableObjectClassName", () => {
  it.each([
    [
      "a default-exported class",
      `import { DurableObject } from "cloudflare:workers"; export default class Counter extends DurableObject {}`,
      "Counter",
    ],
    [
      "an anonymous class",
      `import { DurableObject } from "cloudflare:workers"; export default class extends DurableObject {}`,
      "default",
    ],
    [
      "a class declared first",
      `import { DurableObject } from "cloudflare:workers"; class Store extends DurableObject {} export default Store;`,
      "Store",
    ],
    [
      "a class exported as default by name",
      `import { DurableObject } from "cloudflare:workers"; class Store extends DurableObject {} export { Store as default };`,
      "Store",
    ],
    [
      "a class expression in a const",
      `import { DurableObject } from "cloudflare:workers"; const Store = class extends DurableObject {}; export default Store;`,
      "Store",
    ],
    [
      "a renamed import",
      `import { DurableObject as Base } from "cloudflare:workers"; export default class App extends Base {}`,
      "App",
    ],
    [
      "a namespace import",
      `import * as cf from "cloudflare:workers"; export default class App extends cf.DurableObject {}`,
      "App",
    ],
  ])("recognizes %s", (_label, source, name) => {
    expect(durableObjectClassName(source)).toBe(name);
  });

  it.each([
    ["a plain class", `export default class Plain {}`],
    ["a function", `export default function run() {}`],
    [
      "no default export",
      `import { DurableObject } from "cloudflare:workers"; export class App extends DurableObject {}`,
    ],
    [
      "a DurableObject from somewhere else",
      `import { DurableObject } from "./base.js"; export default class App extends DurableObject {}`,
    ],
    [
      "another cloudflare:workers class",
      `import { WorkerEntrypoint } from "cloudflare:workers"; export default class App extends WorkerEntrypoint {}`,
    ],
    ["a re-export", `export { default } from "./counter.js";`],
    ["source that doesn't parse", `export default class {`],
  ])("ignores %s", (_label, source) => {
    expect(durableObjectClassName(source)).toBeUndefined();
  });
});
