/**
 * Starts the example in `vite dev`, which builds the container image, and gives the tests its URL.
 * remoteExec() in vite.config.ts gets the remote-exec build. Stops the server afterwards, with the
 * containers' network sidecars it leaves running: enough of those exhaust Docker's kernel keyring,
 * after which no container starts.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
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
  const server = await createServer({
    root: EXAMPLE,
    configFile: join(EXAMPLE, "vite.config.ts"),
    server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 8799), strictPort: true },
    logLevel: "warn",
  });
  await server.listen();
  project.provide("base", `http://127.0.0.1:${server.config.server.port}`);
  return async () => {
    await server.close();
    removeSidecars();
  };
}
