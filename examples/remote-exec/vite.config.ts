import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { remoteExec } from "@cloudflare/computer/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// This repository's own remote-exec builds, when there are some (`npm run build:bin --workspace
// @cloudflare/remote-exec`, or CI's).
const local = fileURLToPath(new URL("../../artifacts/remote-exec", import.meta.url).href);

export default defineConfig({
  plugins: [
    cloudflare(),
    // Serves `computer:remote-exec`: the x86_64 build, which the container needs, as Cloudflare runs
    // it linux/amd64. Downloaded from the @cloudflare/computer release that matches the installed
    // package, unless there are local builds.
    remoteExec({ builds: existsSync(local) ? local : undefined }),
  ],
});
