// kitebuild-runtime ships BusyBox and its initramfs as precompiled wasm
// modules; the consumer's Worker bundler uploads them as such.
declare module "@cloudflare/kitebuild-runtime/artifacts/*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
