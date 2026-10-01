import type { WorkerJavaScriptPlugin } from "../../backends/worker-javascript/index.js";
import { PUPPETEER_BROWSER_BINDING } from "./constants.js";
import puppeteerModuleSource from "./generated.js";

export interface PuppeteerBrowserBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface PuppeteerPluginOptions {
  /** Browser Run binding from the host Worker's environment. */
  readonly browser: PuppeteerBrowserBinding;
}

/** Install Cloudflare Puppeteer and its Browser Run binding in JavaScript executions. */
export function puppeteer(options: PuppeteerPluginOptions): WorkerJavaScriptPlugin {
  if (options?.browser === undefined || typeof options.browser.fetch !== "function") {
    throw new TypeError("puppeteer plugin requires a Browser Run binding");
  }
  return {
    modules: {
      "@cloudflare/puppeteer": puppeteerModuleSource,
    },
    bindings: {
      [PUPPETEER_BROWSER_BINDING]: options.browser,
    },
  };
}

export default puppeteer;
