---
"@cloudflare/computer": patch
---

`createGitClient({ fetch })` sends every Git network request through a host `fetch`, so a wrapper can add credentials the model never sees. See [Host Fetch and authentication](https://github.com/cloudflare/computer/blob/main/docs/13_git_interface.md#host-fetch-and-authentication).
