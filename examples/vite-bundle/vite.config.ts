import { computerBundle } from "@cloudflare/computer/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  // computerBundle() serves `computer:bundle/<dir>` imports: each one
  // becomes the directory's files, as text, plus a build-time version.
  plugins: [cloudflare(), computerBundle()],
});
