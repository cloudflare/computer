# Security Policy

> [!IMPORTANT]
> Most of Cloudflare Computer is stable, meaning suitable for production use. The parts listed below are experimental or deprecated. Do not rely on them for production security guarantees. The [status table](../packages/computer/README.md#status) describes the same split by API.
>
> Reporting a security issue: If you find what you believe to be a security issue, please open a GitHub issue in this repository describing it.

## Experimental code

These directories and files hold experimental code:

- `packages/computerd/`: the `computerd` daemon and its FUSE mount.
- `packages/computer-computerd-linux-x64/`: the `computerd` container image.
- `packages/rpc/`: the RPC wire protocol between the durable object and `computerd`.
- `packages/computer/src/backends/container/`: the container backend.
- `packages/computer/src/backends/worker-shell/`: the Worker shell backend and its shell command groups.
- `packages/computer/src/modules/container.ts`: the `ws:container` host module.
- `packages/dofs/src/sync/`: the sync protocol building blocks.
- `packages/dofs/src/schema/sync.ts`: the tables that hold sync state.

`workspace.push()` and `workspace.pull()` in `packages/computer/src/workspace.ts` drive the sync with `computerd`, so they are experimental too, even though the rest of that file is stable.

## Deprecated code

These directories hold deprecated code, which will be removed in a future release:

- `packages/computer/src/backends/container-legacy/`: the legacy container backend. Use `packages/computer/src/backends/container/` instead.

## Code that is not shipped

These directories are not part of any published package, so they carry no stability or security guarantees:

- `examples/`: example Workers. Each example's README says which experimental parts it uses.
- `script/`: maintenance scripts and test harnesses.
- `packages/computer/test-harness/`, `packages/computer/src/test-harness/`, `packages/computer/tests/`, and `packages/computer/test-helpers/`: test code.
