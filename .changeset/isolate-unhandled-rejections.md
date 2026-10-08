---
"@cloudflare/computer": patch
---

Isolate JavaScript runs now fail on I/O at module scope or an unhandled rejection, instead of completing silently, with no output.
