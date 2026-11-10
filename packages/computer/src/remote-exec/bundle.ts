import { hex } from "./fs";
import type { Arch, RemoteExecBinaries } from "./install";

function missing(arch: Arch, have: readonly string[]): Error {
  return new Error(
    `this Worker carries no remote-exec build for ${arch} (it has ${have.length ? have.join(", ") : "none"}): ` +
      `add remote-exec-linux-${arch} from the @cloudflare/computer GitHub release, or use an image that has remote-exec`,
  );
}

/**
 * The remote-exec builds a Worker carries, by architecture, as bytes. Download them from the
 * `@cloudflare/computer` GitHub release that matches the package's version, and import them as
 * `Data` modules (Wrangler and the Vite plugin import `.bin` files as bytes):
 *
 * ```ts
 * import x86_64 from "./remote-exec-linux-x86_64.bin";
 * import aarch64 from "./remote-exec-linux-aarch64.bin";
 * createExecModule({ binaries: bundledRemoteExec({ x86_64, aarch64 }), ... });
 * ```
 *
 * Each import is held in memory for the isolate's life. To stream a build from a file instead,
 * use `fileRemoteExec()`. A container whose architecture has no build fails with an error naming
 * it.
 */
export function bundledRemoteExec(builds: Partial<Record<Arch, ArrayBuffer>>): RemoteExecBinaries {
  const hashes = new Map<Arch, Promise<string>>();
  const build = (arch: Arch): ArrayBuffer => {
    const bytes = builds[arch];
    if (bytes === undefined) throw missing(arch, Object.keys(builds));
    return bytes;
  };
  return {
    sha256: (arch) => {
      let hash = hashes.get(arch);
      if (!hash) {
        hash = Promise.resolve()
          .then(() => crypto.subtle.digest("SHA-256", build(arch)))
          .then((d) => hex(new Uint8Array(d)));
        hashes.set(arch, hash);
      }
      return hash;
    },
    open: (arch) => new Blob([build(arch)]).stream(),
  };
}

/** How much of a build `fileRemoteExec()` reads at a time. */
const READ_BYTES = 64 * 1024;

type NodeFs = typeof import("node:fs");

/**
 * The remote-exec builds a Worker carries as files, by architecture, read with `node:fs` (it needs
 * `nodejs_compat`) a chunk at a time, so no build is ever held in memory whole: hashing streams it
 * once per isolate, and installing streams it into the container. Carry only the architectures
 * your containers run; Cloudflare runs `linux/amd64`, and so does `wrangler dev`.
 *
 * In a Worker, the files are under `/bundle`, where workerd puts every module of the upload under
 * its name. Include the build as its own module rather than importing it, which would rename it to
 * a content hash: in `wrangler.jsonc`,
 *
 * ```jsonc
 * "base_dir": "bin", // just the build: wider, and default rules upload more (*.txt, *.bin)
 * "find_additional_modules": true,
 * "rules": [{ "type": "Data", "globs": ["remote-exec"], "fallthrough": false }]
 * ```
 *
 * ```ts
 * createExecModule({ binaries: fileRemoteExec({ x86_64: "/bundle/remote-exec" }), ... });
 * ```
 */
export function fileRemoteExec(paths: Partial<Record<Arch, string>>): RemoteExecBinaries {
  // Imported when first needed, so the rest of this module doesn't need nodejs_compat.
  let fs: Promise<NodeFs> | undefined;
  const nodeFs = () => (fs ??= import("node:fs"));
  const path = (arch: Arch): string => {
    const p = paths[arch];
    if (p === undefined) throw missing(arch, Object.keys(paths));
    return p;
  };
  const read = async (arch: Arch): Promise<ReadableStream<Uint8Array>> => {
    const file = path(arch);
    const { openSync, readSync, closeSync } = await nodeFs();
    const fd = openSync(file, "r");
    let position = 0;
    const close = () => {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    };
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = new Uint8Array(READ_BYTES);
          let n: number;
          try {
            n = readSync(fd, chunk, 0, READ_BYTES, position);
          } catch (error) {
            close();
            throw error;
          }
          if (n === 0) {
            close();
            controller.close();
            return;
          }
          position += n;
          controller.enqueue(n === READ_BYTES ? chunk : chunk.subarray(0, n));
        },
        cancel: close,
      },
      // Read only as fast as the container takes it.
      { highWaterMark: 0 },
    );
  };
  const hashes = new Map<Arch, Promise<string>>();
  return {
    sha256: (arch) => {
      let hash = hashes.get(arch);
      if (!hash) {
        hash = (async () => {
          const { createHash } = await import("node:crypto");
          const digest = createHash("sha256");
          for await (const chunk of await read(arch)) digest.update(chunk);
          return digest.digest("hex");
        })();
        // A failure (a missing file) is retried next time rather than remembered.
        hash.catch(() => hashes.delete(arch));
        hashes.set(arch, hash);
      }
      return hash;
    },
    open: read,
  };
}
