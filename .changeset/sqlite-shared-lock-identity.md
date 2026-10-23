---
"@cloudflare/computer": patch
---

Fix concurrent `sqlite3` writes losing updates in the Worker shell. Each execution built its own filesystem identity, so two commands writing the same database never shared a lock and the later whole-image writeback silently discarded the earlier one.
