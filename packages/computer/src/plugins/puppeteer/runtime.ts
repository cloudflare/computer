import puppeteer, {
  type Browser,
  type BrowserWorker,
  type WorkersLaunchOptions,
} from "@cloudflare/puppeteer";
import { binding } from "workspace-plugin-bindings.js";

import { PUPPETEER_BROWSER_BINDING } from "./constants.js";
import { createBindingForwarder, withClosable } from "./runtime-helpers.js";

export * from "@cloudflare/puppeteer";

/** Browser Run endpoint installed by the Computer Puppeteer plugin. */
export const browserBinding: BrowserWorker = createBindingForwarder(() =>
  binding<BrowserWorker>(PUPPETEER_BROWSER_BINDING),
);

/** Launch a Browser Run session using the binding installed by Computer. */
export function launch(options?: WorkersLaunchOptions): Promise<Browser> {
  return puppeteer.launch(browserBinding, options);
}

/** Launch a connection-bound browser and always close it after the callback settles. */
export async function withBrowser<T>(
  callback: (browser: Browser) => T | Promise<T>,
  options?: WorkersLaunchOptions,
): Promise<T> {
  return withClosable(await launch(options), callback);
}

export default puppeteer;
