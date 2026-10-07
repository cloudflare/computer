// `npm run local` loads this before run-local.mjs. @cloudflare/computer
// imports `cloudflare:workers`, which only workerd provides; the local
// run never reaches those classes, so empty stand-ins are enough.
import { register } from "node:module";

const stub =
  "export class RpcTarget {} export class WorkerEntrypoint {} export class DurableObject {} export const env = {};";

register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: ${JSON.stringify(`data:text/javascript,${stub}`)}, shortCircuit: true };
    }
    return next(specifier, context);
  }`)}`,
);
