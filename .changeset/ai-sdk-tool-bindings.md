---
"@cloudflare/computer": minor
---

`forAISDKTools()` from `@cloudflare/computer/tools/ai-sdk` serves an AI SDK tool set to isolate JavaScript as `ws:tools`, through `createToolBindings()`. Tools that run in the browser or need approval are left out, and a function of tools is read on every call, so an agent can change its tools between turns.
