// remoteExec: a Vite plugin that gets the remote-exec builds a Worker
// carries, and serves them as `computer:remote-exec`:
//
//   import binaries from "computer:remote-exec";
//   createExecModule({ binaries, ... });
//
// It takes the builds from the @cloudflare/computer GitHub release that
// matches the installed package, checks them against the release's
// SHA256SUMS, and keeps them in Vite's cache directory, so only the first
// build downloads them. SHA256SUMS comes from the same release as the
// builds, so it catches a broken download but not a replaced release;
// `sha256` pins the hashes in the consumer's own repository instead.
//
// `vite build` emits each build as `remote-exec-linux-<arch>.bin` beside
// the Worker. Nothing imports it: the output wrangler.json has `no_bundle`,
// so `wrangler deploy` uploads every file the default module rules match,
// and `.bin` files go up as Data modules. workerd then shows them under
// /bundle, and the module streams them from there with fileRemoteExec(),
// so the Worker never holds a build in memory. An import would hold it.
//
// Under `vite dev`, /bundle has only the plugin's entry, so the module
// imports the builds instead (bundledRemoteExec()). Memory doesn't matter
// there.

import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

/** A container architecture remote-exec is built for. */
export type RemoteExecArch = "x86_64" | "aarch64";

export interface RemoteExecPluginOptions {
  /**
   * The architectures to carry. The default is `x86_64` alone: Cloudflare runs containers as
   * `linux/amd64`, and so do `vite dev` and `wrangler dev`.
   */
  arch?: RemoteExecArch | RemoteExecArch[];
  /** The `@cloudflare/computer` release to take the builds from. The default is the installed package's version. */
  version?: string;
  /**
   * A directory of builds named `remote-exec-linux-<arch>` to use instead of downloading them,
   * such as a local build of remote-exec. Relative to the Vite root.
   */
  builds?: string;
  /** Where releases are downloaded from, for tests. The release's tag is appended. */
  releases?: string;
  /**
   * The SHA-256 each build must have, by architecture, in hex: the release's `SHA256SUMS`, pinned
   * in your repository when you install or bump `@cloudflare/computer`. With it, a build that
   * doesn't match fails, downloaded, cached or local, so a release changed after you pinned it
   * can't reach your Worker. Pin every architecture in `arch`.
   */
  sha256?: Partial<Record<RemoteExecArch, string>>;
}

const SPECIFIER = "computer:remote-exec";

// A build on disk, under a `.bin` name.
interface Build {
  arch: RemoteExecArch;
  path: string;
}
const RESOLVED = `\0${SPECIFIER}`;
const RELEASES = "https://github.com/cloudflare/computer/releases/download";

const released = (arch: RemoteExecArch) => `remote-exec-linux-${arch}`;
// `.bin`: the name both Wrangler's default module rules and the Cloudflare plugin read as bytes.
const carried = (arch: RemoteExecArch) => `${released(arch)}.bin`;

export function remoteExec(options: RemoteExecPluginOptions = {}): Plugin {
  const arches = [...new Set([options.arch ?? "x86_64"].flat())];
  const pinned = pins(options.sha256, arches);
  let root = "";
  let cacheDir = "";
  let serving = false;
  let builds: Promise<Build[]> | undefined;
  // The environments whose Worker imports the builds, so each one carries them.
  const carriers = new Set<string>();

  const prepare = () => {
    builds ??= (async () => {
      let files: Build[];
      if (options.builds !== undefined) {
        files = await local(resolve(root, options.builds), cacheDir, arches);
      } else {
        const version = options.version ?? (await installedVersion());
        files = await download(
          options.releases ?? RELEASES,
          version,
          join(cacheDir, version),
          arches,
          pinned,
        );
      }
      return pinned === undefined ? files : await checkPinned(files, pinned, cacheDir);
    })();
    // A failure (offline, say) is tried again by the next build rather than remembered.
    builds.catch(() => (builds = undefined));
    return builds;
  };

  return {
    name: "@cloudflare/computer:remote-exec",
    configResolved(config) {
      root = config.root;
      cacheDir = join(config.cacheDir, "remote-exec");
      serving = config.command === "serve";
    },
    resolveId(id) {
      return id === SPECIFIER ? RESOLVED : undefined;
    },
    async load(id) {
      if (id !== RESOLVED) return undefined;
      const files = await prepare();
      carriers.add(this.environment.name);
      if (serving) {
        // Absolute paths, with forward slashes, which the Cloudflare plugin imports as bytes.
        const imports = files.map(
          ({ path }, i) => `import build${i} from ${JSON.stringify(path.split(sep).join("/"))};`,
        );
        const builds = files.map(({ arch }, i) => `${JSON.stringify(arch)}: build${i}`).join(", ");
        return [
          'import { bundledRemoteExec } from "@cloudflare/computer/remote-exec";',
          ...imports,
          `export default bundledRemoteExec({ ${builds} });`,
          "",
        ].join("\n");
      }
      const paths = Object.fromEntries(arches.map((arch) => [arch, `/bundle/${carried(arch)}`]));
      return [
        'import { fileRemoteExec } from "@cloudflare/computer/remote-exec";',
        `export default fileRemoteExec(${JSON.stringify(paths)});`,
        "",
      ].join("\n");
    },
    async generateBundle() {
      if (!carriers.has(this.environment.name)) return;
      for (const { arch, path } of await prepare()) {
        this.emitFile({ type: "asset", fileName: carried(arch), source: await readFile(path) });
      }
    },
  };
}

// The version of the @cloudflare/computer this plugin is part of. Its package.json is the nearest
// one up from here, wherever the build put this code.
async function installedVersion(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === "@cloudflare/computer" && pkg.version) return pkg.version;
    } catch {
      // No package.json here.
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error("remoteExec: can't find @cloudflare/computer's package.json: pass `version`");
    dir = parent;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// Writes whole or not at all, so a cached build is always one that was checked. Each write has a
// partial file of its own: two builds in one process can download the same build at once, and the
// later rename just replaces the file with the same checked bytes.
async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { mode: 0o755 });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

// Local builds, copied to `.bin` names the Cloudflare plugin imports as bytes under `vite dev`.
async function local(dir: string, cacheDir: string, arches: RemoteExecArch[]): Promise<Build[]> {
  const files: Build[] = [];
  for (const arch of arches) {
    const source = join(dir, released(arch));
    if (!(await exists(source))) throw new Error(`remoteExec: ${source} doesn't exist`);
    const copy = join(cacheDir, "local", carried(arch));
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(source, copy);
    files.push({ arch, path: copy });
  }
  return files;
}

// The pins, lowercased, with one for every architecture carried.
function pins(
  given: Partial<Record<RemoteExecArch, string>> | undefined,
  arches: RemoteExecArch[],
): Partial<Record<RemoteExecArch, string>> | undefined {
  if (given === undefined) return undefined;
  const pinned: Partial<Record<RemoteExecArch, string>> = {};
  for (const arch of arches) {
    const hash = given[arch];
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash))
      throw new Error(`remoteExec: \`sha256\` needs a SHA-256 in hex for ${arch}`);
    pinned[arch] = hash.toLowerCase();
  }
  return pinned;
}

async function sha256Of(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// Every build, wherever it came from, against the hashes the consumer
// pinned. A build that matches is kept under its hash, and served from
// there: another build sharing the cache can replace the file it came
// from, but never what's at that path.
async function checkPinned(
  files: Build[],
  pinned: Partial<Record<RemoteExecArch, string>>,
  cacheDir: string,
): Promise<Build[]> {
  const checked: Build[] = [];
  for (const { arch, path } of files) {
    const bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== pinned[arch])
      throw new Error(
        `remoteExec: ${released(arch)} has SHA-256 ${sha256}, but \`sha256\` pins ${pinned[arch]}. ` +
          "Pin the hashes in the SHA256SUMS of the @cloudflare/computer release you use.",
      );
    const kept = join(cacheDir, "sha256", sha256, carried(arch));
    if (!(await exists(kept))) await writeAtomically(kept, bytes);
    checked.push({ arch, path: kept });
  }
  return checked;
}

async function get(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`remoteExec: can't download ${url}: ${String(error)}`, { cause: error });
  }
  if (!response.ok)
    throw new Error(`remoteExec: can't download ${url}: ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function download(
  releases: string,
  version: string,
  dir: string,
  arches: RemoteExecArch[],
  pinned: Partial<Record<RemoteExecArch, string>> | undefined,
): Promise<Build[]> {
  const files: Build[] = arches.map((arch) => ({ arch, path: join(dir, carried(arch)) }));
  const missing: Build[] = [];
  // A cached build that doesn't match its pin is downloaded again: the
  // release may have been replaced since it was cached, and the pin
  // updated to match.
  for (const file of files) {
    const cached = await exists(file.path);
    if (!cached || (pinned !== undefined && (await sha256Of(file.path)) !== pinned[file.arch]))
      missing.push(file);
  }
  if (missing.length === 0) return files;

  const release = `${releases}/${encodeURIComponent(`@cloudflare/computer@${version}`)}`;
  let sums: string;
  try {
    sums = new TextDecoder().decode(await get(`${release}/SHA256SUMS`));
  } catch (error) {
    throw new Error(
      `${(error as Error).message}. Is there an @cloudflare/computer ${version} release with remote-exec? ` +
        "Pass `version` to take the builds from another release, or `builds` to use local ones.",
      { cause: error },
    );
  }
  for (const { arch, path } of missing) {
    const name = released(arch);
    // `<hash>  <name>`, or `<hash> *<name>` for a binary-mode sum.
    const line = sums.split("\n").find((l) => new RegExp(`^[0-9a-f]{64} [ *]${name}\\s*$`).test(l));
    if (line === undefined) throw new Error(`remoteExec: ${name} isn't in ${release}/SHA256SUMS`);
    const bytes = await get(`${release}/${name}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== line.slice(0, 64))
      throw new Error(
        `remoteExec: ${release}/${name} has SHA-256 ${sha256}, but SHA256SUMS says ${line.slice(0, 64)}`,
      );
    await writeAtomically(path, bytes);
  }
  return files;
}
