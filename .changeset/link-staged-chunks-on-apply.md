---
"@cloudflare/dofs": patch
"@cloudflare/computer": patch
---

Cut peak memory during a sync pull. Applying a file entry now links the chunks the sender already staged instead of reading them back and joining them into one whole-file buffer, which used to hold roughly twice the file size in the isolate at once.
