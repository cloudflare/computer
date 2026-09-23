# repl-playground example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A browser and HTTP playground for the durable JavaScript REPL
(`workspace.repl()` and `createJsToolDefinition()`).

It works like a notebook for agents. Variables and functions persist
between evals, survive restarts, and every capability call is recorded
once, then replayed from the log. The page lets you run cells and inspect
committed history, recorded effects, and live call counters, so you can
see replay make zero live calls.

## What's in the box

A Durable Object per workspace (`ws` param), each hosting a real
`Workspace` with these grants. They are fake, deterministic fixtures
seeded with a planted incident to investigate:

| grant     | what it is                                                |
| --------- | --------------------------------------------------------- |
| `crm`     | customers and tickets (list/get/update/comment/stats)     |
| `billing` | invoices, refunds, revenue summary                        |
| `metrics` | time-series query (`api-eu-west.p99_ms` spikes…)          |
| `logs`    | service log search                                        |
| `team`    | roster data and `oncall(area)`                            |
| `notify`  | notification outbox (nothing is really sent)              |
| `fs`      | the workspace filesystem                                  |
| `fetch`   | real fetch, allowlisted to a few public hosts             |

Run `help()` in a cell for the full docs, or open a grant in the sidebar.

## Run it

```sh
cp .dev.vars.example .dev.vars   # set PLAYGROUND_TOKEN
npm run dev
```

Open http://localhost:8787 or use the CLI:

```sh
PLAYGROUND_TOKEN=change-me npm run play -- eval 'const open = await crm.tickets.list({ status: "open" }); open.length'
PLAYGROUND_TOKEN=change-me npm run play -- restart
PLAYGROUND_TOKEN=change-me npm run play -- eval 'open.length'   # still there, zero live calls
PLAYGROUND_TOKEN=change-me npm run play -- counts
```

## Deploy

This playground runs arbitrary code against its grants, so don't
deploy it unprotected.

```sh
wrangler secret put PLAYGROUND_TOKEN
npm run deploy
```

For browser access, put the hostname behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/)
and set `ACCESS_TEAM` (`https://<team>.cloudflareaccess.com`) and
`ACCESS_AUDS` (your Access application's AUD tag) in `wrangler.jsonc`.
The worker then accepts a verified Access JWT in place of the bearer
token. For the CLI, set `PLAYGROUND_URL`, plus `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` if you're using an Access service token.

## Endpoints

All endpoints except `/health` need auth.

| endpoint                                | purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `GET /`                                 | browser UI                                     |
| `GET /tool?ws=`                         | generated `js` tool name, description, schema  |
| `POST /eval` `{ code, sessionName?, ws? }` | run one cell through the `js` tool          |
| `GET /sessions?ws=`                     | sessions and cell counts                       |
| `GET /history?ws=&session=&effects=1`   | committed cells and recorded effects           |
| `GET /counts?ws=`                       | live capability-call counters and real egress  |
| `GET /outbox?ws=`                       | notifications "sent" by `notify`               |
| `GET /grants`                           | grant declarations shown in the sidebar        |
| `POST /restart` `{ ws? }`               | drop in-memory state (storage survives)        |
| `POST /reset` `{ ws? }`                 | wipe the workspace                             |
