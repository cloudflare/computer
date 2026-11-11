// Types for the modules the Vite plugins serve. Add
// "@cloudflare/computer/vite/client" to `compilerOptions.types`, or
// reference it with a triple-slash directive, so that
// `import files from "computer:bundle/src/skills"` and
// `import binaries from "computer:remote-exec"` type-check.
declare module "computer:bundle/*" {
  const bundle: import("@cloudflare/computer").WorkerBundleSource;
  export default bundle;
}

// remoteExec(): the remote-exec builds the Worker carries, for createExecModule()'s `binaries`.
declare module "computer:remote-exec" {
  const binaries: import("@cloudflare/computer/remote-exec").RemoteExecBinaries;
  export default binaries;
}
