---
"@cloudflare/computerd": minor
---

Ships a second binary, codemode, next to computerd in the release artifacts and the computer-computerd-linux-x64 image. Run inside the container, it sends a script to the workspace's host and prints the result, with subcommands to print the host's TypeScript declarations, search and describe one method at a time, and list what a paused run is waiting on. It dials ws://computer.internal/codemode by default and needs no credentials.
