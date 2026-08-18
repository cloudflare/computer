---
"@cloudflare/computer": minor
---

`IWorkspaceContainerAPI.start()` and `restart()` now take a single `ContainerLaunchSpec` of `{ env, enableInternet }` instead of two arguments, and return which of `launched`, `adopted` or `relaunched` happened. Each launch records its spec, and a container found already running is relaunched unless it matches, because neither the environment nor the internet flag can be changed on a live container. A container started outside this API has no record and is relaunched rather than trusted. `setInactivityTimeout()` joins the interface so a caller that pre-starts containers, such as a warm pool, does not need to reach past it.
