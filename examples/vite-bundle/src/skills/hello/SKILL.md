---
name: hello
description: A sample skill shipped with the Worker. Read it to see how files bundled with computerBundle() reach the workspace, or run its script to check the shell works.
---

# Hello

This file lives in `src/skills/hello/SKILL.md` in the example's source.
The Worker imports the whole `src/skills` directory with
`import skills from "computer:bundle/src/skills"`, and
`WorkerBundle(skills)` copies it to `/workspace/.agents/skills` as a
read-only mount.

Try:

```sh
ls -R /workspace/.agents/skills
sh /workspace/.agents/skills/hello/scripts/hello.sh
```

Under `vite dev`, edit this file and send the next request: the
workspace picks up the new copy without a restart.
