# 18. Migrating to `workspace.runtime`

This change is a breaking preview-API migration. Public execution now uses one router, while filesystem, Git, Assets, and Artifacts remain separate Workspace capabilities.

## API mapping

| Previous API | Runtime API |
|---|---|
| `workspace.shell.exec(command, options)` | `workspace.runtime.exec(command, options)` |
| `workspace.shell.get(id, options)` | `workspace.runtime.getExec(id, options)` |
| `workspace.shell.kill(id, options)` | `workspace.runtime.killExec(id, options)` |
| `workspace.shell.dispose(id, options)` | `workspace.runtime.disposeExec(id, options)` |
| `workspace.code` / script execution | `workspace.runtime.exec(source, { backend: "isolate-javascript", input })` |

`WorkspaceShell` still exists internally to implement command backends. It is not a public Workspace property.

## Default backend IDs

- Cloudflare Container: `container-shell`
- just-bash Dynamic Worker: `isolate-shell`
- ECMAScript Dynamic Worker: `isolate-javascript`

The first configured backend is the default for `runtime.exec()`. Pass `backend` explicitly at security boundaries. Routing is not authorization: trusted gateways must choose from a host-owned allowlist rather than accepting an arbitrary model-supplied backend ID.

## Source semantics

Command backends interpret the first argument as a shell command and reject structured `input`. `isolate-javascript` interprets it as an ECMAScript module and supports structured JSON-compatible input/results, durable relative modules, `node:fs/promises`, and host-owned trusted modules.

## Lifecycle differences

Container command executions use the remote process journal and push/pull synchronization bracket. `isolate-shell` uses the documented limited one-call Worker lifecycle. `isolate-javascript` stores execution status and events in the Workspace database and supports replay, cancellation, disposal, and restart recovery. Completed filesystem and provider side effects are not rolled back when execution fails or is cancelled.
