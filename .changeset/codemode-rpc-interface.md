---
"@cloudflare/computer-rpc": minor
---

Adds the CodemodeRPC interface, the code surface a process inside the container reaches by opening a WebSocket to the host's egress endpoint at /codemode. It carries types, search, and describe for discovering the globals a script may call, execute, which runs a script body and reports completed, paused, or error rather than rejecting, and pending, which lists what a paused run is waiting on. Approval is deliberately not on the surface.
