# Minimal reproduction for cloudflare/computer#133

This deploys `@cloudflare/computer@0.2.1` with `@platformatic/vfs@0.4.0` in an
Agents Durable Object. Each click targets a fresh DO and runs the reported flow
at the workspace root:

1. Write `/hello.txt`.
2. Call `status()`, then `init({ dir: "/" })`.
3. Read `/.git/HEAD` and `/.git/config`.
4. Call `add()`, `status()`, and `commit()`.
5. Directly write/read both `/.ordinary-dotfile` and `/.git/HEAD`.

```sh
npm install
npm run deploy
```

Open the deployed URL and press **Trigger bug**. The page shows every result and
an explicit verdict. In the repro-agent run on 2026-09-10, HEAD/config persisted
and the first commit succeeded, so the reported failure was not observed.
