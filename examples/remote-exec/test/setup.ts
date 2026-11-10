/**
 * Starts the example in `wrangler dev`, which builds the container image, and gives the tests its
 * URL. Puts the remote-exec build in bin/ first (scripts/fetch-remote-exec.sh). Stops wrangler
 * afterwards, with the containers' network sidecars it leaves running: enough of those exhaust
 * Docker's kernel keyring, after which no container starts.
 */
import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    base: string;
  }
}

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..");

function removeSidecars() {
  try {
    const ids = execFileSync(
      "docker",
      ["ps", "-q", "--filter", "name=workerd-computer-remote-exec-example-"],
      { encoding: "utf8" },
    ).trim();
    if (ids) execFileSync("docker", ["rm", "-f", ...ids.split("\n")], { stdio: "ignore" });
  } catch {
    // Docker isn't there to clean up.
  }
}

export default async function setup(project: TestProject) {
  execFileSync("scripts/fetch-remote-exec.sh", { cwd: EXAMPLE, stdio: "inherit" });
  const port = process.env.PORT ?? "8799";
  const wrangler = spawn("npx", ["wrangler", "dev", "--port", port, "--ip", "127.0.0.1"], {
    cwd: EXAMPLE,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes("Ready on")) resolve();
    };
    wrangler.stdout.on("data", onData);
    wrangler.stderr.on("data", onData);
    wrangler.once("exit", (code) => reject(new Error(`wrangler dev exited (${code}):\n${log}`)));
  });
  project.provide("base", `http://127.0.0.1:${port}`);
  return async () => {
    wrangler.kill();
    await new Promise((resolve) => wrangler.once("exit", resolve));
    removeSidecars();
  };
}
