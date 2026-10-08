// Types for the modules computerBundle() serves. Add
// "@cloudflare/computer/vite/client" to `compilerOptions.types`, or
// reference it with a triple-slash directive, so that
// `import files from "computer:bundle/src/skills"` type-checks.
declare module "computer:bundle/*" {
  const bundle: import("@cloudflare/computer").WorkerBundleSource;
  export default bundle;
}
