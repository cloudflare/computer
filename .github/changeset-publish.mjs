#!/usr/bin/env node
// Called by the changesets action in release.yml as the `publish`
// command. It converges the computerd and remote-exec container images before
// publishing npm packages, so a rerun after npm failure is safe: Docker tags
// are pushed again first, then `changeset publish` publishes anything still
// missing from npm. The workflow builds the remote-exec binaries beforehand,
// and the image carries the same bytes as the GitHub release.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...options });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isStable(version) {
  return !version.includes("-");
}

function computerdImageTags(version) {
  const tags = [
    `ghcr.io/cloudflare/computer-computerd-linux-x64:${version}`,
    `registry.cloudflare.com/library/computer-computerd-linux-x64:${version}`,
  ];

  if (isStable(version)) {
    tags.push(
      "ghcr.io/cloudflare/computer-computerd-linux-x64:latest",
      "registry.cloudflare.com/library/computer-computerd-linux-x64:latest",
    );
  }

  return tags;
}

function remoteExecImageTags(version) {
  const tags = [
    `ghcr.io/cloudflare/computer-remote-exec:${version}`,
    `registry.cloudflare.com/library/computer-remote-exec:${version}`,
  ];

  if (isStable(version)) {
    tags.push(
      "ghcr.io/cloudflare/computer-remote-exec:latest",
      "registry.cloudflare.com/library/computer-remote-exec:latest",
    );
  }

  return tags;
}

function imageExists(tag) {
  try {
    execFileSync("docker", ["buildx", "imagetools", "inspect", tag], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function stageComputerdBinary() {
  mkdirSync("packages/computer-computerd-linux-x64/bin", { recursive: true });
  copyFileSync(
    "artifacts/computerd/computerd-linux-x64",
    "packages/computer-computerd-linux-x64/bin/computerd",
  );
  chmodSync("packages/computer-computerd-linux-x64/bin/computerd", 0o755);
}

const { version } = readJson("packages/computerd/package.json");
const tags = computerdImageTags(version);
const missingTags = tags.filter((tag) => !imageExists(tag));

if (missingTags.length === 0) {
  console.log(`computerd image ${version} already exists in both registries; skipping image build`);
} else {
  console.log(`publishing computerd image for @cloudflare/computerd@${version}`);
  console.log(`missing tag(s): ${missingTags.join(", ")}`);

  run("npm", ["run", "build:bin", "--workspace", "@cloudflare/computerd"]);
  stageComputerdBinary();

  const tagArgs = tags.flatMap((tag) => ["--tag", tag]);
  run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--push",
    "--provenance=false",
    ...tagArgs,
    "--file",
    "packages/computer-computerd-linux-x64/Dockerfile",
    "packages/computer-computerd-linux-x64",
  ]);
}

// remote-exec: one image for linux/amd64 and linux/arm64, from the binaries
// in artifacts/remote-exec. Its stages only COPY, so buildx needs no emulation.
const { version: remoteExecVersion } = readJson("packages/remote-exec/package.json");
const remoteExecTags = remoteExecImageTags(remoteExecVersion);
const missingRemoteExecTags = remoteExecTags.filter((tag) => !imageExists(tag));

if (missingRemoteExecTags.length === 0) {
  console.log(
    `remote-exec image ${remoteExecVersion} already exists in both registries; skipping image build`,
  );
} else {
  console.log(`publishing remote-exec image for @cloudflare/remote-exec@${remoteExecVersion}`);
  console.log(`missing tag(s): ${missingRemoteExecTags.join(", ")}`);

  for (const arch of ["x86_64", "aarch64"]) {
    if (!existsSync(`artifacts/remote-exec/remote-exec-linux-${arch}`)) {
      throw new Error(
        `artifacts/remote-exec/remote-exec-linux-${arch} is missing: run npm run build:bin --workspace @cloudflare/remote-exec`,
      );
    }
  }

  run("docker", [
    "buildx",
    "build",
    "--platform",
    "linux/amd64,linux/arm64",
    "--push",
    "--provenance=false",
    ...remoteExecTags.flatMap((tag) => ["--tag", tag]),
    "--file",
    "packages/remote-exec/Dockerfile",
    "artifacts/remote-exec",
  ]);
}

run("npx", ["changeset", "publish"]);
