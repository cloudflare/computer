# pi agent

A one-shot agent built on [pi](https://github.com/earendil-works/pi). Send it a
task, it works in a durable Workspace, and it replies when it is done.

The whole agent loop is the `run` method in [`src/index.ts`](src/index.ts): ask
the model, run whatever tools it asked for, repeat until it stops asking. pi
keeps the list of tools separate from the code that runs them, so
`createPiTools` hands back both — `tools` to show the model, and `execute` to
run one of its requests.

The workspace tools come from
[`@cloudflare/computer/tools/pi`](../../docs/09_tool_interface.md): `read`,
`ls`, `find`, `grep`, `write`, `edit`, `delete`, and `exec`.

[`src/workers-ai.ts`](src/workers-ai.ts) teaches pi to reach Workers AI through
the `AI` binding rather than the REST endpoint, so the example needs no API
key. It is lifted from the pi harness example in
[cloudflare/agents](https://github.com/cloudflare/agents).

## Run it

```sh
npm install
npm run dev --workspace @example/computer-pi
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

This uses the remote Workers AI binding and counts against your account's
Workers AI usage. If your Wrangler login has access to more than one account,
set `CLOUDFLARE_ACCOUNT_ID` before starting.

Small models pick tools less reliably than large ones. If the agent replies
without touching a file, say the task more plainly or try a bigger model in
`MODEL`.
