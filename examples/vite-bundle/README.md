# vite-bundle example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Vite-built Cloudflare Worker + Durable Object whose Workspace ships a
directory from the project, `src/skills`, into every workspace. It uses
`computerBundle()` from `@cloudflare/computer/vite` and `WorkerBundle`
from `@cloudflare/computer`, and works the same under `vite dev`,
`vite preview`, and a deploy.

The shell is just-bash in a Dynamic Worker, as in
[`examples/worker-shell`](../worker-shell), so you can read the bundled
files with ordinary commands.

## How it works

```ts
// vite.config.ts
plugins: [cloudflare(), computerBundle()]
```

```ts
// src/index.ts
import skills from "computer:bundle/src/skills";

mounts: {
  "/workspace/.agents/skills": WorkerBundle(skills),
}
```

1. `computerBundle()` resolves `computer:bundle/src/skills` to a module
   that calls Vite's `import.meta.glob` over `src/skills`, reading each
   file as text, plus a version: a hash of the paths and contents,
   computed at build time.
2. Vite turns each file into its own small module. Under `vite dev`
   they're served by Vite's module runner; `vite build` emits them as
   chunks next to `index.js`, and wrangler uploads each one as an ES
   module.
3. `WorkerBundle(skills)` copies the files to `/workspace/.agents/skills`
   as a read-only mount the first time the workspace is used. It loads
   the file modules only then.
4. When the version changes, the workspace replaces its copy on its next
   start. In production that's a deploy that changed the files. Under
   `vite dev` it's any edit: change `src/skills/hello/SKILL.md` and the
   next request sees it, without restarting the server.

There's no `find_additional_modules` rule in `wrangler.jsonc`.
`@cloudflare/vite-plugin` ignores it, and nothing needs to be under
`/bundle`.

For TypeScript, `tsconfig.json` adds `@cloudflare/computer/vite/client`
to `compilerOptions.types`, so the `computer:bundle/…` import is typed.

## Run it locally

```sh
npm install
npm run dev --workspace @example/computer-vite-bundle
```

```sh
# list the bundled files
curl -X POST http://localhost:5173/c/demo/exec \
  -d '{"command":"ls -R /workspace/.agents/skills"}'

# read the skill
curl -X POST http://localhost:5173/c/demo/exec \
  -d '{"command":"cat /workspace/.agents/skills/hello/SKILL.md"}'

# run the bundled script
curl -X POST http://localhost:5173/c/demo/exec \
  -d '{"command":"sh /workspace/.agents/skills/hello/scripts/hello.sh"}'

# writes are refused: the mount is read-only
curl -X POST http://localhost:5173/c/demo/exec \
  -d '{"command":"echo nope > /workspace/.agents/skills/x.txt"}'
```

Now edit `src/skills/hello/SKILL.md` and run the `cat` again. The
workspace has the new contents.

To try the production build locally:

```sh
npm run preview --workspace @example/computer-vite-bundle
```

`vite preview` serves on port 4173.

## Layout

```
examples/vite-bundle/
  vite.config.ts    cloudflare() + computerBundle()
  wrangler.jsonc    Worker + DO + worker_loaders binding
  src/index.ts      Worker handler + DO (Agent)
  src/skills/       Files mounted read-only at /workspace/.agents/skills
```

## Limits

- Text files only. Files are read as UTF-8, so binary files are
  corrupted. For binary files, use the wrangler form of `WorkerBundle`
  shown in [`examples/worker-shell`](../worker-shell).
- Dotfiles and `node_modules` are skipped, as with `import.meta.glob`.
- The bundled files count toward the Worker's script size.

See [Mount Interface](../../docs/06_mount_interface.md#shipping-the-files-with-vite)
for the full reference.
