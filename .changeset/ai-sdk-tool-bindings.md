---
"@cloudflare/computer": minor
---

`forAISDKTools()` from `@cloudflare/computer/tools/ai-sdk` serves an AI SDK tool set to isolate JavaScript as `ws:tools`, through `createToolBindings()`. Tools that run in the browser or need approval are left out, and a function of tools is read on every call, so an agent can change its tools between turns.

`createToolBindings()` now normalizes a tool name that cannot be a JavaScript export instead of failing the connection: separators become `_` and other characters an identifier cannot hold are dropped, so `list-files` is exported as `list_files`.
