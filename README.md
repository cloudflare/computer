# Reproduction for cloudflare/computer #114

This is the minimal deployed-Containers probe for `@cloudflare/computer@0.2.1` and
`ghcr.io/cloudflare/computer-computerd-linux-x64:0.2.1`.

1. `npm install`
2. `npm run deploy`
3. Open the printed Worker URL and press **Trigger bug**.

The repro-agent's temporary preview account could serve the frontend but could
not provision the configured Container. Deploy this branch to a
Containers-enabled account to exercise the reported transport failure.

The Worker calls `getWorkspace()` on a container-enabled Durable Object and then
runs `printf 'transport-ok\n'`. On the affected deployed transport, the daemon's
`/health` and outbound `/ws` requests can reach the Worker but the pending
WebSocket upgrade never completes, ending in `[stage=ws]: /ws upgrade did not
arrive`.

The release-branch comparison is in `release-probe/` on the published repro
branch. It pins the release preview package and matching 0.3.0 image expected by
the refactored `/api` protocol.
