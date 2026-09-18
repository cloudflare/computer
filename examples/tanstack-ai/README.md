# TanStack AI agent

A one-shot agent built on [TanStack AI](https://tanstack.com/ai). Send it a
task, it works in a durable Workspace, and it replies when it is done.

There is no loop to write here. `chat()` owns it: it calls the tools the model
asks for, feeds the results back, and keeps going until the model is finished.
`streamToText` waits for that and returns the final text. The agent is about
ten lines in [`src/index.ts`](src/index.ts).

The workspace tools come from
[`@cloudflare/computer/tools/tanstack`](../../docs/09_tool_interface.md):
`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and `exec`. They
arrive keyed by name, which is the shape `chat()` wants.

The Cloudflare adapter talks to Workers AI through the `AI` binding, so the
example needs no API key.

## Run it

```sh
npm install
npm run dev --workspace @example/computer-tanstack-ai
```

Then give it something to do:

```sh
curl -X POST http://localhost:8787 \
  -H 'content-type: application/json' \
  -d '{"task":"Write a haiku about durable objects to /workspace/haiku.txt, then read it back."}'
```

The agent writes the file with the `write` tool and reads it back with `read`,
then says what it did. Ask it to `grep` or run a shell command and it will
reach for those tools instead.

To make it ask before changing anything, pass `approve: "mutating"` to
`createTanStackTools`. Tools marked that way pause for confirmation instead of
running straight away.

This uses the remote Workers AI binding and counts against your account's
Workers AI usage. If your Wrangler login has access to more than one account,
set `CLOUDFLARE_ACCOUNT_ID` before starting.

Small models pick tools less reliably than large ones. If the agent replies
without touching a file, say the task more plainly or try a bigger model in
`MODEL`.
