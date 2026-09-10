---
"@cloudflare/computerd": minor
---

Ships a second binary, codemode, next to computerd in the release artifacts and the computer-computerd-linux-x64 image. Run inside the container, it sends a script to the workspace's host and prints the result, or prints the host's TypeScript declarations with --types. It dials ws://computer.internal/codemode by default and needs no credentials.
