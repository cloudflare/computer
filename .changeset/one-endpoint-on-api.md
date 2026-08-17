---
"@cloudflare/computer": minor
---

The capnweb session now runs on `/api` at both ends of the connection, replacing `/ws`. A durable object that routes the container's outbound upgrade must match `/api` in its `fetch()` handler; `WorkspaceProxy` already does. `POST /connect` carries the endpoint as `{ base, health, api }` so the container assembles no host paths of its own, and a request to `/api` without an `Upgrade` header answers `400` rather than upgrading.
