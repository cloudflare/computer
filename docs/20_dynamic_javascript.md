# Dynamic JavaScript runtime

> [!NOTE]
> **Experimental.** `DynamicJavaScriptBackend` and the way it runs apps may change in any release. See the [status table](../packages/computer/README.md#status).

`DynamicJavaScriptBackend` lets a model make an app and then write code against it. The app is a Durable Object class in a Workspace file. Code that runs on the backend imports that file and calls methods on an instance of the class. Each instance keeps running between executions, with its own SQLite storage, as a [Durable Object facet](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) of the Durable Object that owns the Workspace.

Everything else works as on `WorkerJavaScriptBackend` ([17. Isolate JavaScript](./17_isolate_javascript.md)): the code you pass to `runtime.exec` runs in a fresh Dynamic Worker, with the same module rules, host modules, limits, events, and lifecycle. Apps are what this backend adds.

## Setup

The backend needs the Worker Loader binding and the host Durable Object's `ctx.facets`:

```ts
import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { DynamicJavaScriptBackend } from "@cloudflare/computer/backends/dynamic-javascript";

export class Agent extends DurableObject<Env> {
  workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new DynamicJavaScriptBackend({
        loader: this.env.LOADER,
        facets: this.ctx.facets,
        // Every WorkerJavaScriptBackend option works here too.
      }),
    ],
  });
}
```

```jsonc
// wrangler.jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }],
  "durable_objects": { "bindings": [{ "name": "AGENT", "class_name": "Agent" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Agent"] }]
}
```

The backend's id and type are both `dynamic-javascript` unless you pass `id`.

## Make an app

An app is a Workspace file whose default export is a class that extends `DurableObject` from `cloudflare:workers`:

```js
// /workspace/counter.js
import { DurableObject } from "cloudflare:workers";
import fs from "node:fs/promises";

export default class Counter extends DurableObject {
  increment(by = 1) {
    const total = (this.ctx.storage.kv.get("total") ?? 0) + by;
    this.ctx.storage.kv.put("total", total);
    return total;
  }

  async report() {
    await fs.writeFile("/workspace/total.txt", String(this.ctx.storage.kv.get("total") ?? 0));
  }
}
```

It's a real Durable Object. `this.ctx.storage` has `sql` and `kv`, and `blockConcurrencyWhile` works. Inside its methods, an app can use `node:fs` for the Workspace's files, the backend's source modules, and its `ws:*` host modules, the same as code passed to `exec`. Its imports resolve as they do for that code, and it can import `cloudflare:workers`. Its `env` is empty, and it has no network access unless the backend's `globalOutbound` or `egress` gives it some.

The class has to extend `DurableObject` itself. A class that extends your own base class, even one that extends `DurableObject`, isn't recognized as an app.

## Write code against it

```js
import Counter from "./counter.js";

export default async function () {
  const counter = Counter.get("main");
  await counter.increment(2);
  await counter.report();
  return counter.increment(0);
}
```

When code imports an app, the class doesn't load into the code's isolate. The import gives [`ctx.facets`](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) for that app instead: a `DurableObjectFacets`, with one facet per instance name.

| Call | What it does |
| --- | --- |
| `Counter.get(name)` | Returns the instance called `name`. Each name is a separate instance with its own storage. Getting one does no I/O. |
| `instance.method(...args)` | Runs the method in the instance and resolves with its result. The instance starts the first time it's called. |
| `Counter.abort(name, reason?)` | Stops the instance. Its fields are lost and its storage stays. The next call starts it again. |
| `Counter.delete(name)` | Stops the instance and deletes its storage. The file stays. |
| `Counter.clone(source, destination)` | Replaces the `destination` instance's storage with a copy of the `source` instance's, and restarts `destination`. Cloning an instance that has never stored anything leaves `destination` empty. |

It differs from a real `ctx.facets` in two ways. `get` doesn't take startup options, since the class is always the app's. And an instance isn't a full stub: each method call returns a promise of the result, `fetch` and `connect` aren't available, and values must be plain data, as described below. The runtime doesn't let code construct its own `DurableObjectFacets`, so the import copies its shape: `Counter.constructor.name` is `"DurableObjectFacets"`, and `get`, `abort`, `delete`, and `clone` are on its prototype. Call them on the import, as in `Counter.get(...)`, rather than passing `get` around. Methods on an instance belong to the app, so an app can have methods of its own called `abort` or `delete`.

Only the default export comes through, so a named import from an app's file fails before the run starts. Any other module the code imports that imports the app gets the same `ctx.facets`. A Workspace file that isn't an app imports as an ordinary module.

Arguments and results must be JSON-compatible plain data, and are checked the same way as `exec` input and results. A method can be called if the app's class, or a class between it and `DurableObject`, defines it. Its name can't be `constructor` or start with `_`, so `_helper()` stays private.

## What happens over time

An instance is named after the app's path and the instance's name. `/workspace/counter.js` and `/workspace/lib/../counter.js` are the same app. Moving or renaming the file starts a new app with empty storage, and deleting it leaves its instances' storage behind. Code reaches instances only by importing the app's file, so call `delete(name)` before you move or delete it, or put an app back at the old path to reach the old instances again.

When the app's file, or any module it imports, changes, each instance restarts on its next call and runs the new code. Its storage stays. The backend checks this on every call by reading the app's module graph from the Workspace.

An instance runs one call at a time, in order. A method never interleaves with another call to the same instance, even at an `await`. A call to one instance doesn't wait for calls to another. `clone` waits for the calls already queued on both instances, and later calls to either wait for it.

Keep anything that must last in storage, not in fields. An instance restarts when its code changes, when it's aborted, and when the host Durable Object restarts, is evicted, or is redeployed, since a facet lives and dies with its parent. A call that was running then fails and isn't retried.

Facets can't set alarms, so an app does nothing between calls. Something has to call it.

## Limits

Each call into an instance is one host call of the execution that makes it. It counts against that execution's capability limits and has to finish within `maxHostCallMs`. When it doesn't, the call fails, the execution fails as it would for any late host call, and the instance keeps running. The method can't reach the Workspace once its caller has stopped waiting, but it keeps going until it returns, and calls to that instance queue behind it until then. Call `abort` to stop a method that never returns.

Inside the instance, each call gets its own capability limits for its `node:fs` and host module calls, from the same options. A call's CPU time is limited by `maxCpuMs`.

When a call returns, the backend waits for Workspace calls the method started and didn't await, and refuses any that come later.

Calling an app can write to its storage, so a backend with `access: "read"` refuses every app call.

An app's console output goes nowhere for now.

An app can't call another app. An app that imports another app's file gets the plain class, not its `ctx.facets`.

## Planned: app interfaces

Not built yet. This section records the intended design so later changes can follow it.

An app should be able to have an interface that the agent shows and the user works in, while the agent keeps reading and changing the same instance from code. The plan copies how Cloudflare OS shows the apps its agent writes: over RPC, not HTTP.

The host side gets the same `ctx.facets` shape that code gets when it imports an app:

```ts
const todos = backend.facets("/workspace/todo.js");
const app = todos.get("main"); // an RpcTarget
await app.add("milk");
```

`get(name)` returns an `RpcTarget` whose calls go through the same path as calls from code: a bridge for `node:fs` and host modules, the method guard, plain-data checks, and the instance's queue. So a user and the agent never interleave inside a method. The raw facet stub isn't handed out: the runtime can't pass a facet stub over RPC, and it would skip those checks.

With an agent built on the agents SDK, such as the pi durable harness, the pieces fit like this:

1. The agent writes the app, `todo.js`, and its interface, a sibling file such as `todo.client.js`, then calls a `show_app({ path, name })` tool. The tool records that the app was shown in the session and returns details the chat client renders.
2. The agent's `WebSockets` capability serves an `openApp(path, name)` callable on the Cap'n Web transport (`useAgent({ transport: "capnweb" })`). It refuses apps the agent hasn't shown, and returns the instance from `backend.facets(path).get(name)` with the interface's source. On Workers, capnweb uses the runtime's own `RpcTarget`, so the instance reaches the browser as a live stub.
3. The client renders the result in a sandboxed `srcdoc` iframe with only `allow-scripts` and a `connect-src 'none'` content security policy, so the model-written interface has no origin and no network. Cap'n Web is injected into the frame, and the parent connects a `MessageChannel` to the app stub with `newMessagePortRpcSession`. Interface code calls `await app.add("milk")`. Console output and errors go to the parent, and the frame reopens when the file changes or the connection reconnects, since stubs end with their session.
4. The agent sees what the user did by calling the same instance from code, as in `Todo.get("main").list()`.

The open questions are how stubs on the agents Cap'n Web transport behave across reconnects, and what authority its callables run with.
