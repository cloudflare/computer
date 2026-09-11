---
"@cloudflare/dofs": patch
---

`mkdir` now follows symbolic links in intermediate path segments, so a link to a directory resolves transparently instead of failing with `ENOTDIR`. Creating `/alias/new-directory` where `/alias` points at `/real` creates `/real/new-directory`, and recursive creation places its missing ancestors under the resolved parent. A resolved parent that is a file still reports `ENOTDIR`, a dangling parent link reports `ENOENT`, and a chain longer than the shared forty-hop budget reports `ELOOP`.
