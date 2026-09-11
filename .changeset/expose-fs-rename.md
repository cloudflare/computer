---
"@cloudflare/dofs": minor
"@cloudflare/computer": minor
---

`Workspace.fs` gains `rename(oldPath, newPath)`, exposing the store's existing transactional move through the public surface and through `WorkspaceFilesystemStub`. An existing destination is replaced when the two ends agree on kind — a file or symbolic link for a file or symbolic link, an empty directory for a directory — and the operation reports `ENOENT`, `ENOTEMPTY`, `EISDIR`, `ENOTDIR`, `EINVAL`, and `EROFS` as documented in `docs/04_filesystem_interface.md`. The Worker shell's `mv` now calls it, so an interrupted move no longer leaves the entry at both paths or a directory half copied.
