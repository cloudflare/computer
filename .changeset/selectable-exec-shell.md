---
"@cloudflare/computerd": minor
---

The exec runner now takes an optional shell naming the interpreter each command runs under, and computerd reads the same value from EXEC_SHELL. Both default to /bin/sh, so existing behavior is unchanged. On a Debian-family image /bin/sh is dash, where bash-only syntax such as the PIPESTATUS array is a parse error that aborts the command rather than a missing feature, and that array is how a caller recovers the real exit status of a pipeline whose output it filters. Repointing /bin/sh in the image was the only previous workaround, which changes echo semantics for every other script in that image and is unavailable when the image is prebuilt.
