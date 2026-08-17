---
"@cloudflare/computer": minor
---

The Cap'n Web /ws endpoint has been renamed to /api at both ends of the connection. A durable object that routes the container's outbound upgrade must match /api in its own fetch handler. Support for the Cap'n Web HTTP batch transport has been removed, so /api carries a websocket only.
