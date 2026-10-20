---
"@cloudflare/computer": minor
---

JavaScript backend code can import `cloudflare:computer` for each module's TypeScript declarations, and `console.log` prints a host export's declaration. A module with no exports now runs as the body of the default export instead of failing. Configured modules can no longer use `cloudflare:*` specifiers, and `ws:git` rejects calls that pass anything other than one options object of the options it takes; see [`cloudflare:computer`](https://github.com/cloudflare/computer/blob/main/docs/17_isolate_javascript.md#cloudflarecomputer).
