/**
 * Shared setup for the Node tests: a temporary workspace and container root, private state and
 * socket directories, a LocalTarget pointed at them, and small helpers.
 */
import { existsSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RemoteExecConfig, RemoteProcess } from "../exec";
import { directoryFs, LocalTarget } from "./local";

const CRATE = path.resolve(import.meta.dirname, "../../../../remote-exec");

/** The binary under test: `npm run build:dev --workspace @cloudflare/remote-exec` builds it. */
export const BIN =
  process.env.REMOTE_EXEC_BIN ??
  path.join(process.env.CARGO_TARGET_DIR ?? path.join(CRATE, "target"), "debug/remote-exec");

/** The shared fixtures and golden files, also used by the Rust tests. */
export const TESTS_DIR = path.join(CRATE, "tests");

/** The image's environment the harness gives remote-exec in place of PID 1's. */
export const IMAGE_ENV = "IMAGE_ONLY=from the image\0A=image\0";

export interface Harness {
  base: string;
  /** The workspace, as a real directory; `config.fs` maps /workspace onto it. */
  ws: string;
  /** The container's sync root. */
  ctr: string;
  runDir: string;
  target: LocalTarget;
  config: RemoteExecConfig;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export async function harness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "remote-exec-test-"));
  const ws = path.join(base, "ws");
  const ctr = path.join(base, "ctr");
  const runDir = path.join(base, "run");
  await fsp.mkdir(ws, { recursive: true });
  const imageEnv = path.join(base, "environ");
  await fsp.writeFile(imageEnv, IMAGE_ENV);
  const env = {
    REMOTE_EXEC_STATE_DIR: path.join(base, "state"),
    REMOTE_EXEC_RUN_DIR: runDir,
    REMOTE_EXEC_IMAGE_ENV: imageEnv,
    ...extraEnv,
  };
  const target = new LocalTarget(env);
  return {
    base,
    ws,
    ctr,
    runDir,
    target,
    env,
    config: {
      target,
      fs: directoryFs(ws),
      workspaceRoot: "/workspace",
      containerRoot: ctr,
      agentPath: BIN,
    },
    async cleanup() {
      for (const { child } of target.children) child.kill("SIGKILL");
      await fsp.rm(base, { recursive: true, force: true });
    },
  };
}

export async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [p, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await fsp.writeFile(path.join(root, p), content);
  }
}

export async function tree(root: string, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fsp.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await tree(root, rel)));
    else out.push(rel);
  }
  return out.sort();
}

export async function finish(proc: RemoteProcess) {
  const [stdout, stderr, exitCode] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    proc.stderr ? new Response(proc.stderr).text() : "",
    proc.exitCode,
  ]);
  return { stdout, stderr, exitCode, pulled: await proc.pulled };
}

/** Whether a process exists and isn't a zombie. */
export function alive(pid: number): boolean {
  if (!existsSync(`/proc/${pid}`)) return false;
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
  ms = 5000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
