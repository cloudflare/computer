---
"@cloudflare/computer": minor
---

Rename `WorkerJavaScriptBackend` to `CodemodeBackend`, and change its default id from `"worker-javascript"` to `"codemode"`. There is no alias for the old names. To upgrade:

1. Rename the import path and exports:
   - `@cloudflare/computer/backends/worker-javascript` → `@cloudflare/computer/backends/codemode`
   - `WorkerJavaScriptBackend` → `CodemodeBackend`
   - `WorkerJavaScriptBackendOptions` → `CodemodeBackendOptions`
2. Decide what id the backend uses. A backend without `id` now registers as `"codemode"`, and the exec tool, which shows the model each backend's id, offers it as `"codemode"`. Its `type`, which traces record, is now `"codemode"` whatever the id. Runs are saved under the id of the backend that started them, and a backend only sees runs saved under its own id. A `"codemode"` backend doesn't fail on runs saved under `"worker-javascript"`; it ignores them. It doesn't resume or fail interrupted ones, `runtime.pending()` doesn't list their waiting calls, `runtime.getExec(id)` on it throws `ENOENT`, and the rows stay in storage.
   - To keep runs waiting for a person, saved results and journals, and existing `backend: "worker-javascript"` and `exec: { backends: { "worker-javascript": ... } }` references working, pass `id: "worker-javascript"` to `new CodemodeBackend(...)`. The exec tool then keeps offering it to the model as `"worker-javascript"`.
   - Otherwise, change `backend: "worker-javascript"` to `backend: "codemode"` and `exec.backends` keys from `"worker-javascript"` to `"codemode"`. Left unchanged, `backend: "worker-javascript"` throws `no backend with id "worker-javascript"` and `exec.backends` throws `unknown backend "worker-javascript"`. Runs saved before the upgrade, including any still running or waiting for a person when you deploy, are then out of reach: nothing resumes, lists or cleans them up unless a backend with `id: "worker-javascript"` comes back.
