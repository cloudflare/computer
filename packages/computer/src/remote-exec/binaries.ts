/**
 * The remote-exec builds, for a Worker to carry and copy into containers on first use:
 *
 * ```ts
 * import { REMOTE_EXEC_BINARIES } from "@cloudflare/computer/remote-exec/binaries";
 * createExecModule({ binaries: REMOTE_EXEC_BINARIES, ... });
 * ```
 *
 * Wrangler and the Cloudflare Vite plugin import `.bin` files as bytes. The published package
 * ships both builds in dist/remote-exec/bin. Images that already have remote-exec (copied from
 * the `cloudflare/computer-remote-exec` image) don't need these.
 */
import aarch64 from "./bin/remote-exec-linux-aarch64.bin";
import x86_64 from "./bin/remote-exec-linux-x86_64.bin";
import { bundledRemoteExec } from "./bundle";

export const REMOTE_EXEC_BINARIES = bundledRemoteExec({ x86_64, aarch64 });
