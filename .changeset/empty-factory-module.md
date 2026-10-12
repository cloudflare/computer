---
"@cloudflare/computer": patch
---

A host module factory that builds no functions no longer stops the JavaScript backend from connecting. The backend leaves that module out, so only code that imports it fails, and other runs still start.
