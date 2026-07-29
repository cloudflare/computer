#!/usr/bin/env node
// Build the SEA binary, stamp the platform package's version to match
// packages/computerd/package.json (the source of truth), copy the binary
// into packages/computer-computerd-linux-x64/bin/, and npm publish.
//
// Run manually for now:
//   npm run publish:linux-x64 --workspace @cloudflare/computerd
//
// The script is idempotent — build-bin's no-op detection skips
// re-downloading Node and re-running postject when the artifact is
// fresh, so re-running this is cheap.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const computerdRoot = resolve(here, "..");
const repoRoot = resolve(computerdRoot, "../..");
const platformDir = resolve(repoRoot, "packages/computer-computerd-linux-x64");

const { version } = JSON.parse(readFileSync(resolve(computerdRoot, "package.json"), "utf8"));

// 1. Build the SEA binary. Always re-run; build-bin caches the
//    expensive bits internally.
console.log("[publish-linux-x64] building computerd-linux-x64");
execFileSync("node", ["./scripts/build-bin.mjs"], { cwd: computerdRoot, stdio: "inherit" });

// 2. Stamp the platform package version so it never drifts from the
//    binary's source version. Same number on both sides is the
//    invariant publish flows rely on.
const pkgJsonPath = resolve(platformDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
if (pkg.version !== version) {
  console.log(`[publish-linux-x64] bumping platform package ${pkg.version} -> ${version}`);
  pkg.version = version;
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 3. Copy the binary in. The COPY --from path in downstream
//    Dockerfiles depends on this exact location.
const src = resolve(repoRoot, "artifacts/computerd/computerd-linux-x64");
const dst = resolve(platformDir, "bin/computerd");
copyFileSync(src, dst);
chmodSync(dst, 0o755);
console.log(`[publish-linux-x64] copied ${src} -> ${dst}`);

// 4. Publish. --access public because npm defaults scoped packages
//    to restricted, which would fail without a paid org plan.
console.log(`[publish-linux-x64] publishing @cloudflare/computer-computerd-linux-x64@${version}`);
execFileSync("npm", ["publish", "--access", "public"], {
  cwd: platformDir,
  stdio: "inherit",
});
