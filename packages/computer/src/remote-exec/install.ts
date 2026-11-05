/**
 * Getting remote-exec into the container. Either the image has it already, copied from the
 * `cloudflare/computer-remote-exec` image, or the Worker carries the builds from the GitHub
 * release (`bundledRemoteExec()`) and copies the right one in over exec() stdin on first use.
 */
import { PROTOCOL } from "./messages";
import { startProcess, type ExecTarget } from "./target";

// Checks the private temp copy's --version before moving it into place: once at the shared path,
// a concurrent install can replace it between exec and the binary hashing /proc/self/exe, which then
// fails on overlayfs.
const INSTALL =
  'mkdir -p "$(dirname "$0")" && t="$0.tmp.$$" && cat > "$t" && chmod 755 "$t" && "$t" --version && mv -f "$t" "$0" || { rm -f "$t"; exit 1; }';

export type Arch = "x86_64" | "aarch64";

export interface RemoteExecBinaries {
  /**
   * SHA-256 (hex) of the binary we carry for `arch`. `remote-exec --version` prints the hash of its own
   * executable, so comparing the two says exactly whether the container has our build.
   */
  sha256(arch: Arch): Promise<string>;
  open(arch: Arch): Promise<ReadableStream<Uint8Array>> | ReadableStream<Uint8Array>;
}

async function output(
  target: ExecTarget,
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = await startProcess(target, cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    proc.stderr ? new Response(proc.stderr).text() : "",
    proc.exitCode,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

function hashOf(version: string): string | undefined {
  return /sha256:([0-9a-f]{64})/.exec(version)?.[1];
}

function protocolOf(version: string): number | undefined {
  const match = /\bprotocol (\d+)\b/.exec(version);
  return match ? Number(match[1]) : undefined;
}

/** The architecture names `uname -m` reports, as our builds name them. */
function archOf(machine: string): Arch {
  if (machine === "x86_64" || machine === "amd64") return "x86_64";
  if (machine === "aarch64" || machine === "arm64") return "aarch64";
  throw new Error(`remote-exec has no build for ${JSON.stringify(machine)}`);
}

/**
 * Make sure `agentPath` in the container is a remote-exec we can talk to. Returns what it did.
 *
 * With `binaries`, the container must have exactly the build we carry, which is copied in if it
 * hasn't. Concurrent first calls are safe: each writes its own temp file and `mv -f` is atomic.
 * Without, the image must have one that speaks our protocol.
 */
export async function ensureRemoteExec(
  target: ExecTarget,
  agentPath: string,
  binaries?: RemoteExecBinaries,
): Promise<"present" | "installed"> {
  if (binaries === undefined) {
    const current = await output(target, [agentPath, "--version"]).catch(
      (error: unknown) => ({ code: -1, stdout: "", stderr: String(error) }) as const,
    );
    if (current.code !== 0)
      throw new Error(
        `remote-exec isn't installed at ${agentPath} (${current.stderr || `exit ${current.code}`}): ` +
          "copy it into the image from cloudflare/computer-remote-exec, or pass the builds from the @cloudflare/computer GitHub release as `binaries`",
      );
    const protocol = protocolOf(current.stdout);
    if (protocol !== PROTOCOL)
      throw new Error(
        `${agentPath} reported ${JSON.stringify(current.stdout)}, but this package speaks protocol ${PROTOCOL}: ` +
          "use the cloudflare/computer-remote-exec image whose version matches @cloudflare/computer's",
      );
    return "present";
  }
  const machine = await output(target, ["uname", "-m"]);
  if (machine.code !== 0) throw new Error(`uname -m failed: ${machine.stderr}`);
  const arch = archOf(machine.stdout);
  const want = await binaries.sha256(arch);
  const current = await output(target, [agentPath, "--version"]).catch(() => undefined);
  if (current?.code === 0 && hashOf(current.stdout) === want) return "present";
  const proc = await startProcess(target, ["sh", "-c", INSTALL, agentPath], {
    stdin: await binaries.open(arch),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : "",
    proc.stderr ? new Response(proc.stderr).text() : "",
    proc.exitCode,
  ]);
  if (code !== 0)
    throw new Error(`installing remote-exec into ${agentPath} failed (${code}): ${stderr.trim()}`);
  if (hashOf(stdout) !== want)
    throw new Error(
      `remote-exec reported ${JSON.stringify(stdout.trim())} after install, expected sha256:${want}`,
    );
  return "installed";
}
