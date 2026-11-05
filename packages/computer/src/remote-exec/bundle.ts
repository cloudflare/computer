import { hex } from "./fs";
import type { Arch, RemoteExecBinaries } from "./install";

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
 */
export function bundledRemoteExec(builds: Record<Arch, ArrayBuffer>): RemoteExecBinaries {
  const hashes = new Map<Arch, Promise<string>>();
  return {
    sha256: (arch) => {
      let hash = hashes.get(arch);
      if (!hash) {
        hash = crypto.subtle.digest("SHA-256", builds[arch]).then((d) => hex(new Uint8Array(d)));
        hashes.set(arch, hash);
      }
      return hash;
    },
    open: (arch) => new Blob([builds[arch]]).stream(),
  };
}
