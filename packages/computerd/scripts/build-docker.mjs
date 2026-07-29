#!/usr/bin/env node
// Build the computerd-linux-x64 SEA binary, stage it into the platform
// package, and produce a docker image that downstream Dockerfiles
// can `COPY --from`. Tagged `cloudflare/computer-computerd-linux-x64`
// (matching the npm package name so consumers don't have to
// remember a second identifier) at both the source-of-truth
// version and `latest`.
//
// Usage:
//   node ./scripts/build-docker.mjs            # build only
//   node ./scripts/build-docker.mjs --push     # build + docker push
//
// Idempotent: build-bin's no-op detection skips the expensive parts
// when artifacts/computerd/computerd-linux-x64 is already current.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const computerdRoot = resolve(here, "..");
const repoRoot = resolve(computerdRoot, "../..");
const platformDir = resolve(repoRoot, "packages/computer-computerd-linux-x64");

const { version } = JSON.parse(readFileSync(resolve(computerdRoot, "package.json"), "utf8"));

const IMAGE = "cloudflare/computer-computerd-linux-x64";
const push = process.argv.includes("--push");

// 1. Build the SEA binary.
console.log("[build-docker] building computerd-linux-x64");
execFileSync("node", ["./scripts/build-bin.mjs"], { cwd: computerdRoot, stdio: "inherit" });

// 2. Stage the binary into the platform package's bin/. The
//    .dockerignore restricts the build context to bin/computerd, so the
//    Dockerfile's COPY hits this file directly.
const src = resolve(repoRoot, "artifacts/computerd/computerd-linux-x64");
const dst = resolve(platformDir, "bin/computerd");
copyFileSync(src, dst);
chmodSync(dst, 0o755);
console.log(`[build-docker] staged ${src} -> ${dst}`);

// 3. docker build. --platform pins linux/amd64 because the SEA
//    binary is hard-tied to that ABI; the buildx default would
//    silently produce an arm64 manifest on Apple Silicon hosts.
const buildArgs = [
  "build",
  "--platform",
  "linux/amd64",
  "-t",
  `${IMAGE}:${version}`,
  "-t",
  `${IMAGE}:latest`,
  platformDir,
];
console.log(`[build-docker] docker ${buildArgs.join(" ")}`);
execFileSync("docker", buildArgs, { stdio: "inherit" });

// 4. Optional push. Default is build-only so a contributor running
//    `npm run build:all` doesn't end up authenticated to a registry
//    they didn't ask for.
if (push) {
  for (const tag of [version, "latest"]) {
    console.log(`[build-docker] docker push ${IMAGE}:${tag}`);
    execFileSync("docker", ["push", `${IMAGE}:${tag}`], { stdio: "inherit" });
  }
}

console.log(`[build-docker] ${IMAGE}:${version} ready`);
