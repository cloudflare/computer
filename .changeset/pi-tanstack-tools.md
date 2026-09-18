---
"@cloudflare/computer": minor
---

Add the workspace tools for two more agent libraries, so the same
`read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, and `exec`
tools now work whichever of three libraries an agent is built on.
`@cloudflare/computer/tools/pi` serves pi, which keeps the tool list
apart from the code that runs the tools, so it returns both the
declarations and a dispatcher. `@cloudflare/computer/tools/tanstack`
serves TanStack AI, which runs the tools itself. Both are built from
one shared description of each tool, so names, descriptions and limits
match the existing AI SDK entrypoint, which is unchanged. Each library
is an optional peer dependency, so installing one does not pull in the
others.
