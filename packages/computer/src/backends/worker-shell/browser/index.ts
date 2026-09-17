// Entry for the `browser` shell command group.
//
// build-bundle.mjs bundles this module under the reserved
// `workspace-shell-extras.js` name. Including this group puts that
// module in the Worker Loader table, which is what makes the backend
// name it in the loaded Worker's environment; the shell then loads it
// and registers what it returns. A consumer who never imports the
// group has neither the module nor the command.

import type { CustomCommand } from "just-bash";

import { type BrowserCommandHost, defineBrowserCommand } from "./command.js";

export default function extraCommands(ws: BrowserCommandHost): CustomCommand[] {
  return [defineBrowserCommand(ws)];
}
