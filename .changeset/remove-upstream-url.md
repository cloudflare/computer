---
"@cloudflare/computer": minor
---

The UPSTREAM_URL environment variable has been removed along with the container's own sync loop. Syncing is driven by whichever peer holds the other end of the Cap'n Web session.
