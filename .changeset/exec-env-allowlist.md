---
"@cloudflare/computer": minor
---

A command run through the shell no longer inherits the container's whole environment. It receives PATH, HOME, TMPDIR, TZ, LANG, TERM, the LC_ family, and any variable prefixed COMPUTER_VAR_, which arrives with the prefix stripped so COMPUTER_VAR_NODE_ENV becomes NODE_ENV. A workspace that relied on some other inherited variable needs the prefix.
