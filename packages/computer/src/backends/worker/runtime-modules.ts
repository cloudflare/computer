// Module shims for native dependencies just-bash imports
// statically that workerd can't load. The host Worker merges
// these into the modules table it hands to env.LOADER.get(...)
// so the bundled ShellWorker resolves them at module load time
// without the user's build needing to know about them.
//
// seek-bzip is statically imported by just-bash's tar command
// for .bz2 archive support and ships a `.node` native binding.
// We provide a stub whose `decode` throws only when actually
// invoked, so plain tarballs and gzip in `tar` keep working.
//
// node-liblzma (xz) and @mongodb-js/zstd are reached through
// `await import(...)` wrapped in try/catch inside just-bash, so
// they don't need stubs — leaving them missing from the modules
// table surfaces a clean "module not found" error if a script
// reaches for them.

const SEEK_BZIP_STUB = `
// Stub for seek-bzip, statically imported by just-bash's tar
// command for .bz2 archive support. The real module ships a
// .node native binding workerd can't load. just-bash only
// touches decode when a script reaches for bzip2; surface a
// clean runtime error in that case and leave the rest of tar
// working.

const decode = () => {
  throw new Error(
    "bzip2 decompression is not available in this Worker — " +
      "the seek-bzip native module is not loadable inside workerd.",
  );
};

export default { decode };
`;

// Module entries the host Worker spreads into the Worker Loader
// callback's `modules` field. Sample wiring:
//
//   env.LOADER.get(loaderId, () => ({
//     mainModule: "shell.js",
//     modules: {
//       ...SHELL_MODULES,
//       ...SHELL_RUNTIME_MODULES,
//     },
//     ...
//   }));
//
// Each entry uses Worker Loader's `{js: "..."}` Module shape
// rather than a bare string so the runtime accepts module names
// without a file extension (e.g. "seek-bzip").
export const SHELL_RUNTIME_MODULES: Readonly<Record<string, { js: string }>> = Object.freeze({
  "seek-bzip": { js: SEEK_BZIP_STUB },
});
