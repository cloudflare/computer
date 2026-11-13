---
"@cloudflare/computer": patch
---

`CodemodeBackend` takes an experimental `onDetachedExit`, and `workspace.runtime.detachExec(id)` leaves an exec running with nothing waiting on it, so its exit goes to `onDetachedExit`, saved with the exit and delivered again after a restart or from `runtime.recover()`; see [Detaching](https://github.com/cloudflare/computer/blob/main/docs/05_runtime_interface.md#detaching).
