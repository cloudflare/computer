#!/usr/bin/env node
// Called by the changesets action in release.yml as the `version`
// command. It consumes pending changesets, then applies release-time
// references that must be committed with the Version Packages PR.
//
// Changesets owns package versions and changelogs, including private
// packages (`privatePackages.version` is enabled in .changeset/config.json).
// The linux-x64 image context is derivative of @cloudflare/computerd, not a
// changeset target, so this script copies computerd's version into that
// package.json and updates Dockerfile/docs image pins to the same version.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IMAGE_TAG_RE =
  /(ghcr\.io\/cloudflare\/computer-computerd-linux-x64:)[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/g;
const TEXT_FILE_EXTENSIONS = new Set([
  "",
  ".Dockerfile",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".yaml",
  ".yml",
]);
const IGNORED_DIRS = new Set([".git", ".devbox", ".venv", "artifacts", "dist", "node_modules"]);
const IGNORED_FILES = new Set([
  "package-lock.json",
  "CHANGELOG.md",
  ".github/changeset-version.mjs",
]);

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".github") continue;

    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(path);
      continue;
    }

    if (!entry.isFile()) continue;
    if (IGNORED_FILES.has(path) || IGNORED_FILES.has(entry.name)) continue;
    if (entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.")) {
      yield path;
      continue;
    }

    const suffix = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : "";
    if (TEXT_FILE_EXTENSIONS.has(suffix)) yield path;
  }
}

function syncDerivedImagePackage(computerdVersion) {
  const path = "packages/computer-computerd-linux-x64/package.json";
  const pkg = readJson(path);
  pkg.version = computerdVersion;
  pkg.private = true;
  writeJson(path, pkg);
  console.log(`${path}: derivative image package version → ${computerdVersion}`);
}

function updateImageReferences(computerdVersion) {
  let updatedFiles = 0;
  let replacements = 0;

  for (const file of walk(".")) {
    const before = readFileSync(file, "utf8");
    if (!IMAGE_TAG_RE.test(before)) {
      IMAGE_TAG_RE.lastIndex = 0;
      continue;
    }

    IMAGE_TAG_RE.lastIndex = 0;
    const after = before.replace(IMAGE_TAG_RE, `$1${computerdVersion}`);
    if (after !== before) {
      const count = before.match(IMAGE_TAG_RE)?.length ?? 0;
      writeFileSync(file, after);
      updatedFiles += 1;
      replacements += count;
      console.log(`${file}: computerd image tag → ${computerdVersion}`);
    }
    IMAGE_TAG_RE.lastIndex = 0;
  }

  console.log(
    `updated ${replacements} computerd image tag reference(s) across ${updatedFiles} file(s)`,
  );
}

run("npx", ["changeset", "version"]);

const { version: computerdVersion } = readJson("packages/computerd/package.json");
syncDerivedImagePackage(computerdVersion);
updateImageReferences(computerdVersion);

// changeset version doesn't update package-lock.json (changesets/changesets#421).
run("npm", ["install", "--package-lock-only"]);
