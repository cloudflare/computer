import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { createBuilder, createServer, preview, type InlineConfig } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { remoteExec, type RemoteExecPluginOptions } from "./remote-exec";

const here = dirname(fileURLToPath(import.meta.url));
const WRANGLER = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin/wrangler.js",
);
const VERSION = "9.9.9";
const TAG = encodeURIComponent(`@cloudflare/computer@${VERSION}`);

// Two fake builds, and a release that serves them with their sums.
const builds = { x86_64: randomBytes(200_000), aarch64: randomBytes(150_000) };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let sums = Object.entries(builds)
  .map(([arch, bytes]) => `${sha256(bytes)}  remote-exec-linux-${arch}`)
  .join("\n");

let server: Server;
let releases = "";
const requests: string[] = [];

beforeAll(async () => {
  server = createHttpServer((req, res) => {
    requests.push(req.url ?? "");
    const prefix = `/${TAG}/`;
    const name = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : "";
    const arch = name.replace(/^remote-exec-linux-/, "") as keyof typeof builds;
    const body =
      name === "SHA256SUMS"
        ? sums
        : name.startsWith("remote-exec-linux-")
          ? builds[arch]
          : undefined;
    if (body === undefined) res.writeHead(404).end();
    else res.writeHead(200).end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  releases = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  requests.length = 0;
});

// A Worker that answers with the SHA-256 of each build it carries, as remote-exec's installer
// reads it, so a response proves the builds reached the Worker whole.
function project(worker = WORKER): string {
  const root = mkdtempSync(join(tmpdir(), "computer-remote-exec-vite-"));
  tempDirs.push(root);
  const files = {
    "wrangler.jsonc": JSON.stringify({
      name: "fixture",
      main: "src/index.js",
      compatibility_date: "2025-09-15",
      compatibility_flags: ["nodejs_compat"],
    }),
    "src/index.js": worker,
  };
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

const WORKER = [
  'import binaries from "computer:remote-exec";',
  "export default {",
  "  async fetch(request) {",
  '    const arch = new URL(request.url).searchParams.get("arch") ?? "x86_64";',
  "    try { return new Response(await binaries.sha256(arch)); }",
  "    catch (error) { return new Response(String(error), { status: 500 }); }",
  "  },",
  "};",
  "",
].join("\n");

// The fixture lives in a temporary directory, without node_modules, so the generated module's
// import of the package resolves to its source here.
function config(
  root: string,
  options: RemoteExecPluginOptions = {},
  cacheDir?: string,
): InlineConfig {
  return {
    root,
    configFile: false,
    ...(cacheDir === undefined ? {} : { cacheDir }),
    logLevel: "silent",
    resolve: {
      alias: { "@cloudflare/computer/remote-exec": resolve(here, "../remote-exec/index.ts") },
    },
    plugins: [
      cloudflare({ configPath: join(root, "wrangler.jsonc"), inspectorPort: false }),
      remoteExec({ releases, version: VERSION, ...options }),
    ],
  };
}

async function build(
  root: string,
  options?: RemoteExecPluginOptions,
  cacheDir?: string,
): Promise<string> {
  const builder = await createBuilder(config(root, options, cacheDir));
  await builder.buildApp();
  return join(root, "dist/fixture");
}

describe("remoteExec vite plugin", () => {
  it("emits each build beside the Worker, where wrangler deploy uploads it as a module", async () => {
    const out = await build(project(), { arch: ["x86_64", "aarch64"] });
    expect(readFileSync(join(out, "remote-exec-linux-x86_64.bin"))).toEqual(builds.x86_64);
    expect(readFileSync(join(out, "remote-exec-linux-aarch64.bin"))).toEqual(builds.aarch64);
    // The output config bundles nothing, and its rules leave .bin to Wrangler's default Data rule.
    const output = JSON.parse(readFileSync(join(out, "wrangler.json"), "utf8")) as {
      main: string;
      no_bundle: boolean;
      rules: { type: string; globs: string[] }[];
    };
    expect(output.no_bundle).toBe(true);
    expect(output.rules.flatMap((rule) => rule.globs).some((glob) => glob.endsWith(".bin"))).toBe(
      false,
    );
    // The Worker streams the builds from /bundle rather than importing them.
    const entry = readFileSync(join(out, output.main), "utf8");
    expect(entry).toContain("/bundle/remote-exec-linux-x86_64.bin");
    expect(entry).not.toMatch(/(from|import)\s*["']computer:remote-exec["']/);

    // What wrangler deploy would upload: each build, whole, as a module under its own name.
    const upload = mkdtempSync(join(tmpdir(), "computer-remote-exec-upload-"));
    tempDirs.push(upload);
    const log = execFileSync(
      process.execPath,
      [WRANGLER, "deploy", "--dry-run", "--outdir", upload, "-c", join(out, "wrangler.json")],
      { cwd: out, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
    expect(log).toMatch(/remote-exec-linux-x86_64\.bin\s*│\s*buffer/);
    expect(readFileSync(join(upload, "remote-exec-linux-x86_64.bin"))).toEqual(builds.x86_64);
    expect(readFileSync(join(upload, "remote-exec-linux-aarch64.bin"))).toEqual(builds.aarch64);
  });

  it("serves the built Worker its builds from /bundle", async () => {
    const root = project();
    await build(root);
    const server = await preview({ ...config(root), preview: { port: 0, host: "127.0.0.1" } });
    try {
      const url = server.resolvedUrls?.local[0] ?? "";
      expect(await (await fetch(url)).text()).toBe(sha256(builds.x86_64));
      // Only the architectures asked for.
      const other = await fetch(`${url}?arch=aarch64`);
      expect(other.status).toBe(500);
      expect(await other.text()).toMatch(/no remote-exec build for aarch64/);
    } finally {
      await server.close();
    }
  });

  it("serves the Worker its builds under vite dev, where /bundle doesn't have them", async () => {
    const server = await createServer({
      ...config(project()),
      server: { port: 0, host: "127.0.0.1" },
    });
    await server.listen();
    try {
      const url = server.resolvedUrls?.local[0] ?? "";
      expect(await (await fetch(url)).text()).toBe(sha256(builds.x86_64));
    } finally {
      await server.close();
    }
  });

  it("downloads each build once, and only for a Worker that uses them", async () => {
    const root = project();
    await build(root);
    expect(requests).toEqual([`/${TAG}/SHA256SUMS`, `/${TAG}/remote-exec-linux-x86_64`]);
    requests.length = 0;
    await build(root);
    expect(requests).toEqual([]);

    const plain = project('export default { fetch: () => new Response("hi") };\n');
    const out = await build(plain);
    expect(requests).toEqual([]);
    expect(readdirSync(out).filter((name) => name.endsWith(".bin"))).toEqual([]);
  });

  it("lets two builds in one process download into the same cache at once", async () => {
    const cache = mkdtempSync(join(tmpdir(), "computer-remote-exec-cache-"));
    tempDirs.push(cache);
    const outs = await Promise.all([
      build(project(), undefined, cache),
      build(project(), undefined, cache),
    ]);
    for (const out of outs)
      expect(readFileSync(join(out, "remote-exec-linux-x86_64.bin"))).toEqual(builds.x86_64);
    const cached = join(cache, "remote-exec", VERSION);
    expect(readdirSync(cached)).toEqual(["remote-exec-linux-x86_64.bin"]);
    expect(readFileSync(join(cached, "remote-exec-linux-x86_64.bin"))).toEqual(builds.x86_64);
  });

  it("takes local builds instead, when given them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "computer-remote-exec-builds-"));
    tempDirs.push(dir);
    const local = randomBytes(1000);
    writeFileSync(join(dir, "remote-exec-linux-x86_64"), local);
    const out = await build(project(), { builds: dir });
    expect(readFileSync(join(out, "remote-exec-linux-x86_64.bin"))).toEqual(local);
    expect(requests).toEqual([]);

    await expect(build(project(), { builds: join(dir, "nowhere") })).rejects.toThrow(
      /doesn't exist/,
    );
  });

  it("refuses a build whose SHA-256 isn't the release's", async () => {
    const saved = sums;
    sums = sums.replace(sha256(builds.x86_64), "0".repeat(64));
    try {
      await expect(build(project())).rejects.toThrow(
        /has SHA-256 [0-9a-f]{64}, but SHA256SUMS says 0{64}/,
      );
    } finally {
      sums = saved;
    }
  });

  it("says what to do when there's no such release", async () => {
    await expect(build(project(), { version: "0.0.1" })).rejects.toThrow(
      /404.*Pass `version` to take the builds from another release, or `builds` to use local ones/,
    );
  });
});
