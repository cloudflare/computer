#!/usr/bin/env node
// Sync the version of every published package in lockstep.
// Usage:
//   node script/set-versions.mjs 0.1.0-alpha.2
//   node script/set-versions.mjs v0.1.0-alpha.2   # leading 'v' tolerated
//
// Both @cloudflare/workspace and @cloudflare/workspace-wsd-linux-x64
// land at the same release tag. The release workflow runs this with
// the pushed tag before publishing.

import { readFile, writeFile } from "node:fs/promises";
import { argv } from "node:process";

const PACKAGES = [
  "packages/workspace/package.json",
  "packages/wsd-linux-x64/package.json",
  // wsd itself stays private, but its package.json version is what
  // the build-docker.mjs script reads to tag the published image.
  // Keeping it in lockstep means the docker tag matches the npm
  // tag.
  "packages/wsd/package.json",
];

// Example Dockerfiles pin a specific
// ghcr.io/cloudflare/workspace-wsd-linux-x64:<version> in their
// first FROM line. Bump it in lockstep with the npm version so a
// `git clone && wrangler dev` against any release tag pulls the
// matching wsd image.
const DOCKERFILES = [
  "examples/codemode/Dockerfile",
  "examples/container/Dockerfile",
  "examples/think/Dockerfile",
  "examples/think-compare-runtimes/Dockerfile.workspace",
];
const WSD_IMAGE_TAG_RE = /(ghcr\.io\/cloudflare\/workspace-wsd-linux-x64:)[^\s]+/g;

const raw = argv[2];
if (raw === undefined) {
  console.error("usage: set-versions.mjs <version>");
  process.exit(2);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`bad version: ${raw}`);
  process.exit(2);
}

for (const pkg of PACKAGES) {
  const json = JSON.parse(await readFile(pkg, "utf8"));
  json.version = version;
  await writeFile(pkg, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${pkg}: version → ${version}`);
}

for (const dockerfile of DOCKERFILES) {
  const before = await readFile(dockerfile, "utf8");
  if (!WSD_IMAGE_TAG_RE.test(before)) {
    console.error(`${dockerfile}: no wsd-linux-x64 image tag matched ${WSD_IMAGE_TAG_RE}`);
    process.exit(2);
  }
  // RegExp with /g keeps lastIndex between calls; reset before replace().
  WSD_IMAGE_TAG_RE.lastIndex = 0;
  const after = before.replace(WSD_IMAGE_TAG_RE, `$1${version}`);
  if (after !== before) await writeFile(dockerfile, after);
  console.log(`${dockerfile}: wsd image tag → ${version}`);
}
