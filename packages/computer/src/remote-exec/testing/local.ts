/**
 * Node-only test helpers: an ExecTarget that runs commands as local processes (standing in for
 * `ctx.container.exec()`), and a SyncFs over a directory on disk (standing in for computer's
 * workspace filesystem).
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import type { SyncFs } from "../fs";
import type { ExecTarget, ExecTargetOptions, ExecTargetProcess } from "../target";

export class LocalTarget implements ExecTarget {
  readonly children: { cmd: string[]; child: ChildProcess }[] = [];
  constructor(readonly env: Record<string, string> = {}) {}

  async exec(cmd: string[], options: ExecTargetOptions = {}): Promise<ExecTargetProcess> {
    const stdinMode =
      options.stdin === "pipe" || options.stdin instanceof ReadableStream ? "pipe" : "ignore";
    const stdoutMode = options.stdout === "ignore" ? "ignore" : "pipe";
    const stderrMode = options.stderr === "ignore" ? "ignore" : "pipe";
    if (options.stderr === "combined") throw new Error("LocalTarget doesn't do combined");
    const [program, ...args] = cmd;
    if (program === undefined) throw new TypeError("empty command");
    const child = spawn(program, args, {
      stdio: [stdinMode, stdoutMode, stderrMode],
      env: { ...process.env, ...this.env, ...options.env },
      cwd: options.cwd,
    });
    this.children.push({ cmd, child });
    const exitCode = new Promise<number>((resolve) => {
      child.on("exit", (code, signal) =>
        resolve(code ?? 128 + (signal ? signalNumber(signal) : 0)),
      );
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (options.stdin instanceof ReadableStream && child.stdin) {
      void options.stdin
        .pipeTo(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
        .catch(() => undefined);
    }
    return {
      pid: child.pid ?? -1,
      stdin:
        options.stdin === "pipe" && child.stdin
          ? (Writable.toWeb(child.stdin) as WritableStream<Uint8Array>)
          : undefined,
      stdout: child.stdout
        ? (Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
        : undefined,
      stderr: child.stderr
        ? (Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>)
        : undefined,
      exitCode,
      kill: (signal = 15) => {
        child.kill(signal);
      },
    };
  }
}

function signalNumber(name: NodeJS.Signals): number {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGUSR2: 12,
    SIGTERM: 15,
  };
  return table[name] ?? 0;
}

/** A SyncFs where the virtual path `virtualRoot` is the real directory `realRoot`. */
export function directoryFs(realRoot: string, virtualRoot = "/workspace"): SyncFs {
  const real = (p: string) => {
    if (p !== virtualRoot && !p.startsWith(`${virtualRoot}/`)) {
      // Spill files go to /.computer/output; keep them inside the test directory too.
      return path.join(realRoot, "..", "outside", p);
    }
    return path.join(realRoot, p.slice(virtualRoot.length));
  };
  return {
    async readdir(p, options) {
      const entries = await fsp.readdir(real(p), { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = entries.slice(
        options?.offset ?? 0,
        (options?.offset ?? 0) + (options?.limit ?? entries.length),
      );
      return Promise.all(
        page.map(async (e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink(),
          mtime: (await fsp.lstat(path.join(real(p), e.name))).mtimeMs,
        })),
      );
    },
    async lstat(p) {
      const s = await fsp.lstat(real(p));
      return {
        mode: s.mode,
        size: s.size,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
      };
    },
    readlink: (p) => fsp.readlink(real(p)),
    async readFile(p) {
      const data = await fsp.readFile(real(p));
      return new Blob([data]).stream();
    },
    async writeFile(p, content, options) {
      // Streams to disk as chunks arrive, as computer's chunked writer does, so a write that fails
      // midway leaves a partial file behind for the tests to notice.
      const handle = await fsp.open(real(p), "w");
      try {
        if (content instanceof Uint8Array) await handle.write(content);
        else for await (const chunk of content) await handle.write(chunk);
      } finally {
        await handle.close();
      }
      if (options?.mode !== undefined) await fsp.chmod(real(p), options.mode);
    },
    async mkdir(p, options) {
      await fsp.mkdir(real(p), options);
    },
    async rm(p, options) {
      await fsp.rm(real(p), options);
    },
    rename: (a, b) => fsp.rename(real(a), real(b)),
    symlink: (t, p) => fsp.symlink(t, real(p)),
  };
}
