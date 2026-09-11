---
"@cloudflare/computer": minor
---

`git clone` now fetches the full history by default instead of a single commit. The shallow default was faster, but a caller who cloned a repository and then pushed it somewhere else sent only the one commit it had fetched: the push reported success and the remote's tip matched, while every earlier commit was missing. Pass `--depth` to ask for a shallow clone when the history genuinely is not needed.

`git cat-file` gained `-t` and `-s` to report an object's type and size, alongside the existing `-p`. Exactly one of the three is required, as in real git.

`git log` gained `--format` and its alias `--pretty`, expanding the placeholders `%H`, `%h`, `%s`, `%b`, `%an`, `%ae`, `%ad`, `%cn`, `%ce`, `%cd`, and `%%`, plus the named format `oneline`. A placeholder outside that set is left as written so it is visible in the output rather than silently dropped.

`git help <command>` now prints the usage line for one command instead of ignoring its argument and reprinting the full list. Only the flags this wrapper accepts are listed, so the output says what works here rather than what real git would take.
