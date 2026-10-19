---
"@cloudflare/computerd": patch
---

Directory listings on the mount now report each entry's type and inode, on synced and local-only paths alike. Before, every entry came back as `DT_UNKNOWN`, which `bun install` treats as nothing to link: with its cache under a local-only path such as `/workspace/.cache`, it left packages out of `node_modules` and failed with `failed to enqueue lifecycle scripts ...: ENOENT`. Tools that read `d_type`, such as `find` and `git`, no longer need an `lstat` per entry to learn it.
