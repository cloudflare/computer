#!/usr/bin/env node
// Cross-compile computerd to a self-contained Node SEA binary for each supported
// target. Steps per target:
//   1. esbuild a single ESM bundle (see scripts/sea/bundle.mjs).
//   2. Write a sea-config.json that names the bundle as main and lists the
//      target-specific native assets (fuse-native prebuild + libfuse).
//   3. Generate the SEA blob via `node --experimental-sea-config`.
//   4. Download the target's Node binary (cached under .devbox/node-binaries),
//      copy it into artifacts/, and inject the blob with postject.
//   5. (macOS) strip and reapply an ad-hoc signature so the kernel will load
//      the modified binary.
//
// Everything used at runtime is embedded; the resulting artifact has no
// sidecar files.
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { bundleComputerd } from "./sea/bundle.mjs";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const computerdRoot = resolve(here, "..");
const repoRoot = resolve(computerdRoot, "../..");
const outputDir = resolve(repoRoot, "artifacts/computerd");
const seaWorkDir = resolve(computerdRoot, "dist/sea");
const nodeCacheDir = resolve(repoRoot, ".devbox/node-binaries");
const nodeVersion = "v22.22.3";

const targets = [
  {
    name: "linux-x64",
    outputName: "computerd-linux-x64",
    nodeArchive: `node-${nodeVersion}-linux-x64.tar.xz`,
    nodeBinaryInArchive: `node-${nodeVersion}-linux-x64/bin/node`,
    addon: "node_modules/fuse-native/prebuilds/linux-x64/node.napi.node",
    libfuse: "node_modules/fuse-shared-library-linux/libfuse/lib/libfuse.so",
    libfuseName: "libfuse.so.2",
    envVar: "LD_LIBRARY_PATH",
    isMac: false,
  },
  {
    name: "macos-x64",
    outputName: "computerd-macos-x64",
    nodeArchive: `node-${nodeVersion}-darwin-x64.tar.xz`,
    nodeBinaryInArchive: `node-${nodeVersion}-darwin-x64/bin/node`,
    addon: "node_modules/fuse-native/prebuilds/darwin-x64/node.napi.node",
    // fuse-native's darwin prebuild ships its own libosxfuse.dylib next to
    // the .node addon. macFUSE installs the same library system-wide, but
    // we embed our copy so the binary doesn't require the user to have
    // macFUSE pre-installed on the dynamic loader search path.
    libfuse: "node_modules/fuse-native/prebuilds/darwin-x64/libosxfuse.dylib",
    libfuseName: "libosxfuse.2.dylib",
    envVar: "DYLD_LIBRARY_PATH",
    isMac: true,
  },
];

async function main() {
  await runNpm("build");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(seaWorkDir, { recursive: true });
  await mkdir(nodeCacheDir, { recursive: true });

  for (const target of targets) {
    console.log(`[computerd-bin] building ${target.name}`);
    await buildTarget(target);
  }

  console.log(`wrote standalone binaries to ${outputDir}`);
}

async function buildTarget(target) {
  const bundlePath = resolve(seaWorkDir, `${target.name}.bundle.mjs`);
  const blobPath = resolve(seaWorkDir, `${target.name}.blob`);
  const configPath = resolve(seaWorkDir, `${target.name}.sea-config.json`);
  const outBin = resolve(outputDir, target.outputName);

  await bundleComputerd({ outfile: bundlePath, target });

  await writeFile(
    configPath,
    JSON.stringify(
      {
        main: resolve(here, "sea/bootstrap.cjs"),
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
        assets: {
          "bundle.mjs": bundlePath,
          "fuse-native.node": resolve(repoRoot, target.addon),
          [target.libfuseName]: resolve(repoRoot, target.libfuse),
        },
      },
      null,
      2,
    ),
  );

  await execFileP(process.execPath, ["--experimental-sea-config", configPath]);

  const nodeBinary = await ensureTargetNodeBinary(target);
  await copyFile(nodeBinary, outBin);
  await chmod(outBin, 0o755);

  if (target.isMac) {
    // `codesign --remove-signature` only exists on macOS hosts. Skip with a
    // warning on linux build hosts — the binary will still load on macOS
    // after the user (or a downstream signer) re-signs it.
    await maybe(execFileP("codesign", ["--remove-signature", outBin]));
  }

  const postjectArgs = [
    resolve(repoRoot, "node_modules/postject/dist/cli.js"),
    outBin,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ];
  if (target.isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
  await execFileP(process.execPath, postjectArgs);

  if (target.isMac) {
    await maybe(execFileP("codesign", ["--sign", "-", outBin]));
  }
}

async function ensureTargetNodeBinary(target) {
  const extractedPath = resolve(nodeCacheDir, target.nodeBinaryInArchive);
  if (await exists(extractedPath)) return extractedPath;

  const archivePath = resolve(nodeCacheDir, target.nodeArchive);
  if (!(await exists(archivePath))) {
    const url = `https://nodejs.org/dist/${nodeVersion}/${target.nodeArchive}`;
    console.log(`[computerd-bin] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`failed to download ${url}: ${res.status}`);
    const tmpPath = `${archivePath}.${process.pid}.tmp`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpPath));
    await execFileP("mv", [tmpPath, archivePath]);
  }

  await execFileP("tar", ["-xJf", archivePath, "-C", nodeCacheDir]);
  if (!(await exists(extractedPath))) {
    throw new Error(`extraction did not produce ${extractedPath}`);
  }
  return extractedPath;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function maybe(promise) {
  try {
    return await promise;
  } catch (err) {
    console.warn(`[computerd-bin] non-fatal: ${err.message}`);
  }
}

function runNpm(script) {
  return new Promise((res, rej) => {
    const child = execFile("npm", ["run", script], { cwd: computerdRoot });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.once("exit", (code) =>
      code === 0 ? res() : rej(new Error(`npm run ${script} exited ${code}`)),
    );
    child.once("error", rej);
  });
}

await main();
