#!/usr/bin/env node
// Builds computerd as a self-contained Node SEA binary. linux-x64 is the
// published target; COMPUTERD_BIN_TARGETS=linux-arm64 (or a comma-separated
// list) builds others, for running natively on an arm64 machine.
//
// The binary embeds the FUSE addon but links the system libfuse 3, so the
// image that runs it needs libfuse 3.17 or newer (Debian trixie's fuse3).
// COMPUTERD_FUSE_ADDON names a prebuilt fuse.node to use instead of
// compiling one; it applies to every target in the run.
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

// Same Node major as the SEA runtime, and same Debian release as the
// container images, so the addon links the libfuse those images carry.
const addonBuildImage = "node:22-trixie-slim";
const minimumLibfuse = [3, 17];

const allTargets = [
  {
    name: "linux-x64",
    outputName: "computerd-linux-x64",
    nodeArchive: `node-${nodeVersion}-linux-x64.tar.xz`,
    nodeBinaryInArchive: `node-${nodeVersion}-linux-x64/bin/node`,
    dockerPlatform: "linux/amd64",
  },
  {
    name: "linux-arm64",
    outputName: "computerd-linux-arm64",
    nodeArchive: `node-${nodeVersion}-linux-arm64.tar.xz`,
    nodeBinaryInArchive: `node-${nodeVersion}-linux-arm64/bin/node`,
    dockerPlatform: "linux/arm64",
  },
];

const requestedTargets = (process.env.COMPUTERD_BIN_TARGETS ?? "linux-x64")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");
const targets = requestedTargets.map((name) => {
  const target = allTargets.find((candidate) => candidate.name === name);
  if (target === undefined) {
    throw new Error(
      `unknown COMPUTERD_BIN_TARGETS entry ${JSON.stringify(name)}; ` +
        `expected one of ${allTargets.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  return target;
});

async function main() {
  await runNpm("build");
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

// Compiled in a container so the result doesn't depend on the build host:
// CI runners carry libfuse 3.14, too old for passthrough, and a developer
// machine may not be x64. Cached because an emulated compile takes minutes.
async function buildAddon(target) {
  const override = process.env.COMPUTERD_FUSE_ADDON;
  if (override !== undefined && override !== "") {
    console.log(`[computerd-bin] using prebuilt addon ${override}`);
    return resolve(override);
  }

  const outDir = resolve(seaWorkDir, `${target.name}-addon`);
  const addonPath = resolve(outDir, "fuse.node");
  const keyPath = resolve(outDir, "fuse.node.key");
  const key = await addonCacheKey(target);
  if ((await exists(addonPath)) && (await readText(keyPath)) === key) return addonPath;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  console.log(`[computerd-bin] compiling fuse-napi for ${target.name} in ${addonBuildImage}`);
  await runInContainer(
    target.dockerPlatform,
    [`${addonSourceDir}:/src:ro`, `${outDir}:/out`],
    [
      "set -eu",
      "apt-get update -qq",
      "apt-get install -y -qq --no-install-recommends g++ make python3 pkg-config libfuse3-dev >/dev/null",
      "mkdir /build",
      "tar -C /src --exclude=./build --exclude=./node_modules -cf - . | tar -C /build -xf -",
      "cd /build",
      "npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error",
      "npx --yes node-gyp@11 rebuild --nodedir=/usr/local --loglevel=error",
      "cp build/Release/fuse.node /out/fuse.node",
      "pkg-config --modversion fuse3 > /out/libfuse-version",
    ],
  );

  assertLibfuseVersion((await readText(resolve(outDir, "libfuse-version"))).trim());
  await writeFile(keyPath, key);
  return addonPath;
}

// Detached, then waited on: an attached `docker run` against a remote
// daemon can lose its stream and return before the container finishes.
async function runInContainer(platform, volumes, scriptLines) {
  const volumeArgs = volumes.flatMap((volume) => ["-v", volume]);
  const { stdout } = await execFileP("docker", [
    "run",
    "-d",
    "--platform",
    platform,
    ...volumeArgs,
    addonBuildImage,
    "sh",
    "-c",
    scriptLines.join("\n"),
  ]);
  const id = stdout.trim();
  try {
    const { stdout: status } = await execFileP("docker", ["wait", id]);
    if (status.trim() !== "0") {
      const logs = await execFileP("docker", ["logs", id], { maxBuffer: 64 * 1024 * 1024 });
      throw new Error(`fuse-napi build exited ${status.trim()}:\n${logs.stdout}${logs.stderr}`);
    }
  } finally {
    await execFileP("docker", ["rm", "-f", id]).catch(() => {});
  }
}

function assertLibfuseVersion(version) {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [minMajor, minMinor] = minimumLibfuse;
  if (major < minMajor || (major === minMajor && minor < minMinor)) {
    throw new Error(
      `${addonBuildImage} carries libfuse ${version}; passthrough needs ` +
        `${minimumLibfuse.join(".")} or newer`,
    );
  }
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
