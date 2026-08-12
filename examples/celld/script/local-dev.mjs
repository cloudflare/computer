#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "local",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "local",
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  CELLD_WORKER_LOADER: process.env.CELLD_WORKER_LOADER || "LOADER",
  CELLD_WATCH: process.env.CELLD_WATCH || ".celld-state",
};

for (const name of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
  const value = process.env[`CELLD_VAR_${name}`] || process.env[name];
  if (value) env[`CELLD_VAR_${name}`] = value;
}

const children = new Set();

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
    ...options,
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (!options.allowExit && code !== 0) {
      console.error(`${name} exited with ${signal || code}`);
      shutdown(code || 1);
    }
  });
  return child;
}

function run(name, command, args) {
  return new Promise((resolve, reject) => {
    const child = start(name, command, args, { allowExit: true });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)),
    );
  });
}

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

start("local-s3-shim", process.execPath, [
  "script/local-s3-shim.mjs",
  "--root",
  ".celld-s3",
  "--port",
  "9000",
]);
await delay(300);

await run("celld deploy", "celld", [
  "deploy",
  ".",
  "--bucket",
  "s3://celld-computer",
  "--endpoint",
  "http://127.0.0.1:9000",
  "--region",
  "us-east-1",
]);

if (!env.CELLD_VAR_CLOUDFLARE_ACCOUNT_ID || !env.CELLD_VAR_CLOUDFLARE_API_TOKEN) {
  console.warn(
    "Cloudflare credentials are unset; the agent can connect, but model requests will fail.",
  );
}

start("celld", "celld", [
  "--bucket",
  "s3://celld-computer",
  "--endpoint",
  "http://127.0.0.1:9000",
  "--region",
  "us-east-1",
  "--listen",
  "127.0.0.1:8080",
  "--advertise",
  "127.0.0.1:8080",
]);

console.log("\ncelld is starting on http://127.0.0.1:8080");
console.log("Open the terminal client with `npm run chat`.\n");
