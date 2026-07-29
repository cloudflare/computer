---
name: cloudflare
description: |
  Index of Cloudflare-platform skills relevant to this repo. Load when
  working on anything that touches Workers, Durable Objects, wrangler,
  the sandbox SDK, the agents SDK, or other Cloudflare platform surface.
  Triggers include "Cloudflare", "Workers", "Durable Object", "wrangler",
  "KV", "R2", "D1", "Vectorize", "Containers", "sandbox".
---

# Cloudflare platform skills

This repo is built on Cloudflare Workers and Durable Objects. The
authoritative platform guidance lives in the [`cloudflare/skills`](https://github.com/cloudflare/skills)
repository rather than vendored into this repo, so it stays current.
This file is an index — open the relevant skill below when its trigger
applies and read its `SKILL.md` before starting work.

If a skill isn't already available in your environment, fetch it from
the URL listed and load it manually. The fallback for everything is
the official Cloudflare documentation at
<https://developers.cloudflare.com>.

## Primary skills

These three cover almost every change in this repo:

| Skill | Load when |
|---|---|
| [`durable-objects`](https://github.com/cloudflare/skills/tree/main/skills/durable-objects) | Writing or reviewing Durable Object code: RPC methods, SQLite storage, alarms, WebSockets, hibernation. Most work in `packages/dofs` and `packages/computer` qualifies. |
| [`workers-best-practices`](https://github.com/cloudflare/skills/tree/main/skills/workers-best-practices) | Writing or reviewing Worker code: streaming, floating promises, global state, bindings, secrets, observability, `wrangler.jsonc` configuration. |
| [`agents-sdk`](https://github.com/cloudflare/skills/tree/main/skills/agents-sdk) | Building on the Cloudflare Agents SDK: stateful agents, Workflows integration, scheduled tasks, MCP servers. Relevant to [`examples/think`](../../../examples/think). |

## Other skills

Load these when their trigger applies:

| Skill | Load when |
|---|---|
| [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler) | Running `wrangler` commands: deploy, dev, secrets, bindings for KV, R2, D1, Vectorize, Hyperdrive, Queues, Workflows, Containers. |
| [`cloudflare`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare) | General Cloudflare platform questions outside the more specific skills above — KV, R2, D1, Vectorize, networking, security, infrastructure-as-code. |
| [`sandbox-sdk`](https://github.com/cloudflare/skills/tree/main/skills/sandbox-sdk) | Building or reviewing sandboxed-execution code paths. Relevant to [`examples/container`](../../../examples/container) and to the `computerd` container model in general. |
| [`web-perf`](https://github.com/cloudflare/skills/tree/main/skills/web-perf) | Profiling page load, Core Web Vitals, or render-blocking issues. Rarely relevant in this repo, but listed for completeness. |
| [`cloudflare-email-service`](https://github.com/cloudflare/skills/tree/main/skills/cloudflare-email-service) | Working with Cloudflare Email Routing or the Email Workers binding. Not currently used in this repo. |

## How this maps to the repo

- **`packages/dofs`** is a Durable Object with SQLite storage. Load
  [`durable-objects`](https://github.com/cloudflare/skills/tree/main/skills/durable-objects)
  before changing storage shape, RPC methods, or alarm handling.
  Load [`workers-best-practices`](https://github.com/cloudflare/skills/tree/main/skills/workers-best-practices)
  for the surrounding Worker glue.
- **`packages/computer`** runs inside the Durable Object and
  exposes the capnweb `WorkspaceRPC` to `computerd`. Load
  [`durable-objects`](https://github.com/cloudflare/skills/tree/main/skills/durable-objects)
  for the hosting model and the [`capnweb`](../capnweb/SKILL.md)
  skill for the RPC surface itself.
- **`packages/computerd`** runs in a sandbox container, not in a Worker.
  Load [`sandbox-sdk`](https://github.com/cloudflare/skills/tree/main/skills/sandbox-sdk)
  if you're working on the container boundary; the FUSE and
  HTTP/WebSocket internals are local to the package.
- **`examples/think`** is an agent. Load
  [`agents-sdk`](https://github.com/cloudflare/skills/tree/main/skills/agents-sdk)
  when changing it.
- **Deploys, secrets, bindings.** Load
  [`wrangler`](https://github.com/cloudflare/skills/tree/main/skills/wrangler)
  before running `wrangler` commands or editing `wrangler.jsonc`.

## When to escalate

If you're about to write something that crosses two Cloudflare
surfaces — say, a Worker that wakes a Durable Object that talks to a
container — load both relevant skills before starting. The skills are
small; loading two is cheaper than fixing an architectural mistake.
