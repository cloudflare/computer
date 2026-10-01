---
"@cloudflare/computer": minor
---

Add the Workspace tool set for two more agent libraries. `createPiAITools` from `@cloudflare/computer/tools/pi-ai` serves [pi](https://github.com/earendil-works/pi), and `createTanStackAITools` from `@cloudflare/computer/tools/tanstack-ai` serves [TanStack AI](https://tanstack.com/ai). Both take the same options as `createAITools`, including `shell`, and build the same tools with the same names, descriptions, and limits.

pi runs tools in the caller's own loop, so `createPiAITools` returns `tools` to send to the model and `execute` to run one tool call. A bad call or a failed tool comes back as an error result instead of a throw. TanStack AI runs tools itself, so `createTanStackAITools` returns the list `chat({ tools })` takes, with `approve`, `lazy`, `format`, and `streamEventName` for TanStack's approval, lazy discovery, and progress events.

Neither entry point imports its library, only `zod`, so adding one does not pull `ai`, pi, or TanStack into a bundle that does not use them.
