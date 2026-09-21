---
"@cloudflare/computer": minor
---

Add the workspace tools for two more agent libraries, so the same
`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and `exec`
tools now work whichever of three libraries an agent is built on.
`@cloudflare/computer/tools/pi` serves pi, which keeps the tool list
apart from the code that runs the tools, so it returns both the
declarations and a dispatcher. `@cloudflare/computer/tools/tanstack`
serves TanStack AI, which runs the tools itself and takes them as a
list, so a list is what it returns; `format: "object"` keys them by
name when a single tool has to be reached. Each library is an optional
peer dependency, so installing one does not pull in the others.

Each library declares its own tools, so it can use that library's own
features directly. What they share is the workspace logic underneath:
the executors, their schemas and descriptions, and the options that
decide which tools exist. `@cloudflare/computer/tools` is unchanged for
AI SDK callers.
