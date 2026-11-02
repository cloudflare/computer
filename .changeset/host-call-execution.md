---
"@cloudflare/computer": minor
---

Host module calls now get `context.execution`, with the `id` of the run they belong to. A replayable run keeps it when it resumes.
