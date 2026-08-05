# 20. Write access and approval

Two related things: a per-command write capability, and a pair of hooks
for deciding and recording what a workspace is asked to do.

## The problem

An agent decides a command is read-only and runs it. Sometimes it is
wrong — an alias, a shell function, a `&&` it did not parse, a script
that writes a lockfile on the way to printing a version. The workspace
is modified, nothing reports it, and the mistake is found later by
whatever breaks next.

Classifying commands correctly is not solvable. What is solvable is
making the classification safe to get wrong: a command believed to be
read-only runs without write access, so if the belief was wrong the
write fails instead of landing.

## Per-command write access

`writable` on an exec call. Defaults to true.

```ts
const handle = await workspace.runtime.exec("git log --oneline", {
  writable: false,
});
```

The capability is per command, not per write. `rm -rf` issues one call
per entry; denying partway through leaves a half-deleted tree. A
command is the smallest unit that can be refused and leave the
workspace in a state the caller can reason about.

It travels with the command rather than being read from configuration,
because commands overlap. A read-only command running beside a writable
one must not be able to disarm it, and must not be able to borrow its
access.

### What "no write access" enforces, per backend

Not the same thing everywhere, and the difference matters when
choosing a backend for work you intend to constrain.

| Backend | Enforcement | Effect of a write |
|---|---|---|
| `worker-shell` | Preventive | Fails inside the command with `EROFS`. Nothing is written. |
| `worker-javascript` | Preventive | The capability handed to the module is narrowed, and the guest shim throws the refusal inside the module. |
| `container-shell` | After the fact | Lands in the container's own copy, then is refused on the way back and reported in `skipped`. |

`worker-shell` shares the host store, so a command that runs there
holds a filesystem handle built without the capability, and the first
write fails where it happens. The command sees an ordinary filesystem
error and reports it like any other.

For `worker-javascript` the per-execution flag is intersected with the
backend's own `access` option rather than replacing it. A backend
registered `access: "read"` stays read-only however the call was made,
and an execution asking to be read-only gets that on a read-write
backend. Neither side widens the other, which is the same rule the gate
follows.

A container has its own copy of the files. By the time the host hears
about a change the container has already written it, so there is
nothing left to prevent — only to refuse. The changes are dropped on
arrival and listed in `skipped` with reason `no-write-access`:

```ts
const result = await handle.result();
for (const entry of result.skipped) {
  if (entry.reason === "no-write-access") {
    // The command wrote this. It was not applied.
  }
}
```

Refusing is discarding, not deferring. A refused change is not
redelivered to the next pull that does have write access, or the
refusal would only be a delay. The consequence is that the container's
copy and the workspace disagree from that point on: the container still
holds the file it wrote. Treat a refused write there as a reason to
discard the container rather than keep using it.

## The gate

Consulted before an action, and able to refuse it.

```ts
new Workspace({
  storage: ctx.storage,
  gate: {
    async check(action) {
      if (action.kind !== "shell.exec") return { allow: true };
      if (isDestructive(action.command)) {
        return { allow: false, reason: "destructive commands need review" };
      }
      return { allow: true };
    },
  },
});
```

A refusal throws `ActionDeniedError`, which carries the action and the
reason. Nothing runs.

A gate may also allow an action with write access withdrawn, which is
the answer for a command a policy will run but not trust:

```ts
return { allow: true, writable: false };
```

Narrowing only. A gate cannot grant access an action did not ask for,
so a read-only exec stays read-only regardless of what the gate
returns.

`check` may be async, and the action does not start until it settles —
long enough to consult a policy service or wait for a human. Whatever
it waits on holds up the caller.

A gate that throws propagates. A gate that could not reach a decision
is not a gate that said no, and code that cannot tell those apart will
eventually treat an outage as permission.

### What is gated

`shell.exec`, once per command, and the mutating methods on
`Workspace.fs` — `writeFile`, `mkdir`, `rm`, `chmod`, `symlink` — once
per call. Reads are not gated.

The filesystem half is there because `Workspace.fs` writes to the store
without crossing the wire. A gate covering only `shell.exec` would have
an obvious way around it: deny the command, write the file directly.

Filesystem calls are gated individually because each call is the whole
action, so refusing one leaves nothing half-finished. That is the
difference from a command, and the reason a command is gated once.

A gate should return `{ allow: true }` for action kinds it does not
recognise, so kinds added later stay permitted rather than being
refused by a gate that was never asked about them.

### Asking a human

Ask before the command starts. Once it is running there is nowhere to
suspend it that does not risk a partial result, and a write-by-write
prompt would ask hundreds of times for one `rm -rf`.

That puts the question at the tool layer rather than at the gate, since
the tool layer is the only one of the two that runs before the action
exists. [`examples/agent`](../examples/agent) wires it that way and is
worth reading for how the two seams divide the work: the tool layer
asks, and the gate — which cannot ask — narrows.

## The audit hook

Notified after an action has been decided, and after it has run.

```ts
new Workspace({
  storage: ctx.storage,
  audit: {
    record(action, outcome) {
      log({ kind: action.kind, status: outcome.status });
    },
  },
});
```

`outcome.status` is `allowed`, `denied`, or `failed`. Refused actions
are reported too, and are usually the more interesting half.

It cannot deny anything, and errors it throws are swallowed. By the
time it runs the action has already happened; failing the caller over a
failed log entry would make an audit hook into a gate.

For `shell.exec` it fires on the spawn, not on the exit. `exec` returns
a detached handle the caller may never drain, so there is no later
moment guaranteed to arrive, and picking one would mean a command that
is dropped is never recorded at all. What the command went on to do is
on the observer's span and on the result.

## Why this is not the observer

The observer in
[11. Lifecycle](./11_lifecycle.md) must return its callback's result
unchanged — observability that changes behaviour is a bug. A gate
exists to change behaviour. They are separate seams with the same shape
and opposite licences, rather than one seam with a weakened contract.

## Tool layer

`createExecTool` takes a `writable` resolver. It is not part of the
tool's input schema, so the model cannot set it:

```ts
createExecTool({
  workspace,
  backends,
  defaultBackend: "worker-shell",
  writable: ({ command }) => !readOnlyCommand(command),
});
```

The model must not classify its own command. The case being defended
against is the command mislabelled as read-only, and asking the model
that mislabelled it to declare the label produces a flag that agrees
with the mistake. The host decides from something it already trusts,
and the model finds out by the write failing.

The effective access is reported on the tool result, so a model can
tell a refused write from a broken command instead of retrying the same
thing. A gate refusal comes back as a tool result too, not a thrown
error, so the agent loop survives it.

## Related

- [04. Filesystem interface](./04_filesystem_interface.md) — `EROFS`
  and the filesystem surface.
- [05. Runtime interface](./05_runtime_interface.md) — exec options and
  the synchronization bracket.
- [06. Mount interface](./06_mount_interface.md) — read-only mounts,
  which are a fixed property of a path rather than a per-command
  decision. Both apply, and neither is a way around the other.
- [09. Tool interface](./09_tool_interface.md) — the agent-facing tools.
- [`examples/agent`](../examples/agent) — all three used together, with
  an approval matcher whose only job is to ask fewer questions and a
  test that runs every command it allows to check that none of them
  write.
