---
"@cloudflare/computer-rpc": minor
---

Adds the CodemodeRPC interface, the code surface a process inside the container reaches by opening a WebSocket to the host's egress endpoint at /codemode. It carries describe, which returns the TypeScript declarations of the globals a script may call, and execute, which runs a script body and reports completed, paused, or error rather than rejecting.
