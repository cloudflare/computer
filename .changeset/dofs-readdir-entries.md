---
"@cloudflare/dofs": patch
---

`SQLiteWorkspaceProvider.readdirEntriesSync(path)` lists a directory with each entry's type, permission bits and inode, as an `lstat` of it reports them, from one query.
