#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, copyFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = process.platform === "win32" ? "tsc.cmd" : "tsc";

await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
await run(tscBin, ["-p", "tsconfig.json"], packageRoot);

// Each CLI entry is emitted as .js by tsc and copied to .cjs so the
// bin points at an explicitly CommonJS file whatever the resolver sees.
for (const entry of ["computerd", "codemode"]) {
  const jsEntry = resolve(packageRoot, `dist/cli/${entry}.js`);
  const cjsEntry = resolve(packageRoot, `dist/cli/${entry}.cjs`);
  await copyFile(jsEntry, cjsEntry);
  await chmod(cjsEntry, 0o755);
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`));
    });
  });
}
