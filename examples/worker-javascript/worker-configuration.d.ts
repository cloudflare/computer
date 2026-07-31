// Hand-written env shape for the platform Worker. Run
// `wrangler types` to regenerate from wrangler.jsonc when the
// bindings change.

interface Env {
  ContainerExample: DurableObjectNamespace<import("./src/index.js").ContainerExample>;
  LOADER: WorkerLoader;
  Bucket: R2Bucket;
}
