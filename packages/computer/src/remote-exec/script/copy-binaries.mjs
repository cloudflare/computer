#!/usr/bin/env node
// Copies the remote-exec builds (artifacts/remote-exec, from `npm run build:bin --workspace
// @cloudflare/remote-exec`) into dist/remote-exec/bin, where `@cloudflare/computer/remote-exec/binaries`
// imports them. Runs after every build; without the builds it only warns, since most work on the
// package doesn't need Rust. `--require` fails instead: prepublishOnly passes it, so a published
// package always carries both.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const from = resolve(pkg, "../../artifacts/remote-exec");
const to = join(pkg, "dist/remote-exec/bin");
const arches = ["x86_64", "aarch64"];

const missing = arches.filter((arch) => !existsSync(join(from, `remote-exec-linux-${arch}`)));
if (missing.length > 0) {
  const message = `remote-exec builds missing for ${missing.join(", ")} in ${from}: run npm run build:bin --workspace @cloudflare/remote-exec`;
  if (process.argv.includes("--require")) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message}. @cloudflare/computer/remote-exec/binaries won't bundle until then.`);
  process.exit(0);
}

mkdirSync(to, { recursive: true });
for (const arch of arches) {
  const dest = join(to, `remote-exec-linux-${arch}.bin`);
  copyFileSync(join(from, `remote-exec-linux-${arch}`), dest);
  chmodSync(dest, 0o755);
}
console.log(`copied the remote-exec builds to ${to}`);
