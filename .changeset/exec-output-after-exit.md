---
"@cloudflare/computerd": patch
---

`computerd` no longer exits when a command's output arrives after the command has exited. A background job started with `&` that later wrote to the inherited stdout or stderr, or output still buffered behind a slow reader when the child exited, threw `append after exit` from a stream listener. That throw reached the daemon's `uncaughtException` handler, and the daemon exited, taking the container with it. Output written between the exit and the pipes closing is now delivered before the exit event. An exec waits `exitDrainMs` (default 250) for a background job holding its pipes, longer while the reader has paused the output, and never more than `exitDrainMaxMs` (default 5000), so a reader that stops reading cannot hold the exec open. Anything a background job writes after that, or after `dispose()`, is dropped.
