#!/usr/bin/env node
// Build computerd as a self-contained Node SEA binary for linux-x64. Steps:
//   1. Compile the vendored fuse-napi addon inside a Debian trixie
//      container for the target platform (see buildAddon below).
//   2. esbuild a single ESM bundle (see scripts/sea/bundle.mjs).
//   3. Write a sea-config.json that names the bundle as main and embeds
//      the addon as an asset.
//   4. Generate the SEA blob via `node --experimental-sea-config`.
//   5. Download the target's Node binary (cached under .devbox/node-binaries),
//      copy it into artifacts/, and inject the blob with postject.
//
// The addon links the system libfuse 3 at runtime rather than carrying a
// copy, so the image that runs the binary needs libfuse 3.17 or newer
// (the `fuse3` package on Debian trixie). Set COMPUTERD_FUSE_ADDON to the
// path of a prebuilt fuse.node to skip the container build.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const addonSourceDir = resolve(computerdRoot, "vendor/fuse-napi");
const nodeVersion = "v22.22.3";

// The addon is built against the same Node major as the SEA runtime and
// the same Debian release as the container images, so the libfuse it
// links is the one that is present when the binary runs.
const addonBuildImage = "node:22-trixie-slim";
const minimumLibfuse = [3, 17];

const targets = [
  {
    name: "linux-x64",
    outputName: "computerd-linux-x64",
    nodeArchive: `node-${nodeVersion}-linux-x64.tar.xz`,
    nodeBinaryInArchive: `node-${nodeVersion}-linux-x64/bin/node`,
    dockerPlatform: "linux/amd64",
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

  const addonPath = await buildAddon(target);
  await bundleComputerd({ outfile: bundlePath });

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
          "fuse.node": addonPath,
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

  const postjectArgs = [
    resolve(repoRoot, "node_modules/postject/dist/cli.js"),
    outBin,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ];
  await execFileP(process.execPath, postjectArgs);
}

// Compile fuse-napi for the target inside a container, so the result
// does not depend on the build host's architecture or on its libfuse.
// CI runners carry an older libfuse 3 than the 3.17 that passthrough
// needs, and a developer machine may not be x64 at all.
//
// The result is cached under dist/sea, keyed on the addon sources and
// the build image, because an emulated compile takes minutes.
async function buildAddon(target) {
  const override = process.env.COMPUTERD_FUSE_ADDON;
  if (override !== undefined && override !== "") {
    console.log(`[computerd-bin] using prebuilt addon ${override}`);
    return resolve(override);
  }

  const outDir = resolve(seaWorkDir, `${target.name}-addon`);
  const addonPath = resolve(outDir, "fuse.node");
  const stampPath = resolve(outDir, "fuse.node.key");
  const key = await addonCacheKey(target);
  if ((await exists(addonPath)) && (await readText(stampPath)) === key) {
    return addonPath;
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  console.log(`[computerd-bin] compiling fuse-napi for ${target.name} in ${addonBuildImage}`);

  const script = [
    "set -eu",
    "apt-get update -qq",
    "apt-get install -y -qq --no-install-recommends g++ make python3 pkg-config libfuse3-dev >/dev/null",
    "mkdir /build",
    "tar -C /src --exclude=./build --exclude=./node_modules -cf - . | tar -C /build -xf -",
    "cd /build",
    "npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error",
    // The image ships the Node headers, so node-gyp does not download them.
    "npx --yes node-gyp@11 rebuild --nodedir=/usr/local --loglevel=error",
    "cp build/Release/fuse.node /out/fuse.node",
    "pkg-config --modversion fuse3 > /out/libfuse-version",
  ].join("\n");

  // Detached, then waited on, rather than an attached `docker run`: an
  // attached client can lose its stream on a remote daemon and return
  // before the container finishes, which would read as a missing addon.
  const { stdout: containerId } = await execFileP("docker", [
    "run",
    "-d",
    "--platform",
    target.dockerPlatform,
    "-v",
    `${addonSourceDir}:/src:ro`,
    "-v",
    `${outDir}:/out`,
    addonBuildImage,
    "sh",
    "-c",
    script,
  ]);
  const id = containerId.trim();
  try {
    const { stdout: status } = await execFileP("docker", ["wait", id]);
    if (status.trim() !== "0") {
      const { stdout, stderr } = await execFileP("docker", ["logs", id], {
        maxBuffer: 64 * 1024 * 1024,
      });
      throw new Error(`fuse-napi build exited ${status.trim()}:\n${stdout}${stderr}`);
    }
  } finally {
    await execFileP("docker", ["rm", "-f", id]).catch(() => {});
  }

  const libfuseVersion = (await readText(resolve(outDir, "libfuse-version"))).trim();
  const [major = 0, minor = 0] = libfuseVersion.split(".").map(Number);
  if (major < minimumLibfuse[0] || (major === minimumLibfuse[0] && minor < minimumLibfuse[1])) {
    throw new Error(
      `${addonBuildImage} carries libfuse ${libfuseVersion}; passthrough needs ` +
        `${minimumLibfuse.join(".")} or newer`,
    );
  }
  await writeFile(stampPath, key);
  return addonPath;
}

async function addonCacheKey(target) {
  const hash = createHash("sha256").update(`${addonBuildImage}\n${target.dockerPlatform}\n`);
  for (const file of ["fuse-native.c", "binding.gyp", "scripts/fuse-config.js", "package.json"]) {
    hash.update(await readFile(resolve(addonSourceDir, file)));
  }
  return hash.digest("hex");
}

async function readText(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return "";
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
