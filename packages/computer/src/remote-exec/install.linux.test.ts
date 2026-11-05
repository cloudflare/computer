import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundledRemoteExec } from "./bundle";
import { ensureRemoteExec, type RemoteExecBinaries } from "./install";
import type { ExecTarget, ExecTargetOptions, ExecTargetProcess } from "./target";
import { BIN, toHex } from "./testing/harness";
import { LocalTarget } from "./testing/local";

let base: string;
beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), "remote-exec-install-"));
});
afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

/** A target whose commands answer from a script, for the paths a real container rarely takes. */
class ScriptedTarget implements ExecTarget {
  readonly calls: string[][] = [];
  constructor(
    private readonly answer: (
      cmd: string[],
      stdin?: ReadableStream<Uint8Array>,
    ) => Promise<{ code: number; stdout?: string; stderr?: string }>,
  ) {}
  async exec(cmd: string[], options?: ExecTargetOptions): Promise<ExecTargetProcess> {
    this.calls.push(cmd);
    const stdin = options?.stdin instanceof ReadableStream ? options.stdin : undefined;
    const result = await this.answer(cmd, stdin);
    return {
      pid: 1,
      stdin: undefined,
      stdout: new Blob([result.stdout ?? ""]).stream(),
      stderr: new Blob([result.stderr ?? ""]).stream(),
      exitCode: Promise.resolve(result.code),
      kill: () => undefined,
    };
  }
}

describe("ensureRemoteExec against the real binary", () => {
  it("without binaries, uses the one the image has", async () => {
    const dest = path.join(base, "bin/remote-exec");
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(BIN, dest);
    expect(await ensureRemoteExec(new LocalTarget(), dest)).toBe("present");
  });

  it("without binaries, explains a missing binary or one that speaks another protocol", async () => {
    const dest = path.join(base, "bin/remote-exec");
    await expect(ensureRemoteExec(new LocalTarget(), dest)).rejects.toThrow(
      /isn't installed at [\s\S]*copy it into the image/,
    );
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, "#!/bin/sh\necho remote-exec 9.0.0 protocol 99 sha256:0000\n", {
      mode: 0o755,
    });
    await expect(ensureRemoteExec(new LocalTarget(), dest)).rejects.toThrow(
      /speaks protocol 1: use the cloudflare\/computer-remote-exec image/,
    );
  });

  it("installs over stdin, leaves a matching binary alone, and replaces a different one", async () => {
    const bytes = new Uint8Array(await fsp.readFile(BIN));
    const binaries: RemoteExecBinaries = {
      sha256: async () => sha256(bytes),
      open: () => new Blob([bytes]).stream(),
    };
    const dest = path.join(base, "deep/bin/remote-exec");
    const target = new LocalTarget();
    expect(await ensureRemoteExec(target, dest, binaries)).toBe("installed");
    expect((await fsp.stat(dest)).mode & 0o777).toBe(0o755);
    expect(await ensureRemoteExec(target, dest, binaries)).toBe("present");
    await fsp.writeFile(dest, "#!/bin/sh\necho remote-exec 0.0.0 protocol 1 sha256:0000\n");
    expect(await ensureRemoteExec(target, dest, binaries)).toBe("installed");
    expect(await ensureRemoteExec(target, dest, binaries)).toBe("present");
  });

  it("concurrent first installs all succeed and leave one good binary", async () => {
    const bytes = new Uint8Array(await fsp.readFile(BIN));
    const binaries: RemoteExecBinaries = {
      sha256: async () => sha256(bytes),
      open: () => new Blob([bytes]).stream(),
    };
    const dest = path.join(base, "bin/remote-exec");
    const target = new LocalTarget();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureRemoteExec(target, dest, binaries)),
    );
    expect(results.every((r) => r === "installed" || r === "present")).toBe(true);
    expect(await sha256(new Uint8Array(await fsp.readFile(dest)))).toBe(await sha256(bytes));
    expect((await fsp.readdir(path.join(base, "bin"))).filter((f) => f.includes(".tmp"))).toEqual(
      [],
    );
  });
});

describe("ensureRemoteExec failure paths", () => {
  const binaries: RemoteExecBinaries = {
    sha256: async () => "ab".repeat(32),
    open: () => new Blob(["binary"]).stream(),
  };

  it("maps uname names to builds and refuses unknown machines", async () => {
    for (const [machine, arch] of [
      ["x86_64", "x86_64"],
      ["amd64", "x86_64"],
      ["aarch64", "aarch64"],
      ["arm64", "aarch64"],
    ] as const) {
      const asked: string[] = [];
      const target = new ScriptedTarget(async (cmd) =>
        cmd[0] === "uname"
          ? { code: 0, stdout: `${machine}\n` }
          : { code: 0, stdout: `remote-exec 0.1.0 protocol 1 sha256:${"ab".repeat(32)}` },
      );
      await ensureRemoteExec(target, "/x", {
        sha256: async (a) => {
          asked.push(a);
          return "ab".repeat(32);
        },
        open: binaries.open,
      });
      expect(asked, machine).toEqual([arch]);
    }
    const riscv = new ScriptedTarget(async () => ({ code: 0, stdout: "riscv64" }));
    await expect(ensureRemoteExec(riscv, "/x", binaries)).rejects.toThrow(/no build for "riscv64"/);
  });

  it("reports a failing uname, a failing install, and a wrong binary after install", async () => {
    await expect(
      ensureRemoteExec(
        new ScriptedTarget(async () => ({ code: 1, stderr: "no uname" })),
        "/x",
        binaries,
      ),
    ).rejects.toThrow(/uname -m failed/);

    const failingInstall = new ScriptedTarget(async (cmd) =>
      cmd[0] === "uname"
        ? { code: 0, stdout: "x86_64" }
        : cmd[0] === "sh"
          ? { code: 1, stderr: "read-only file system" }
          : { code: 127 },
    );
    await expect(ensureRemoteExec(failingInstall, "/x", binaries)).rejects.toThrow(
      /failed \(1\): read-only file system/,
    );

    const wrongAfter = new ScriptedTarget(async (cmd) =>
      cmd[0] === "uname"
        ? { code: 0, stdout: "x86_64" }
        : cmd[0] === "sh"
          ? { code: 0, stdout: `remote-exec 0.1.0 protocol 1 sha256:${"cd".repeat(32)}` }
          : { code: 127 },
    );
    await expect(ensureRemoteExec(wrongAfter, "/x", binaries)).rejects.toThrow(/after install/);
  });

  it("sends the binary as the install command's stdin, to the path given", async () => {
    let received = "";
    let installedTo = "";
    const target = new ScriptedTarget(async (cmd, stdin) => {
      if (cmd[0] === "uname") return { code: 0, stdout: "x86_64" };
      if (cmd[0] === "sh") {
        received = stdin ? await new Response(stdin).text() : "";
        installedTo = cmd.at(-1) ?? "";
        return { code: 0, stdout: `remote-exec x protocol 1 sha256:${"ab".repeat(32)}` };
      }
      return { code: 127 };
    });
    expect(await ensureRemoteExec(target, "/opt/tools/remote-exec", binaries)).toBe("installed");
    expect(received).toBe("binary");
    expect(installedTo).toBe("/opt/tools/remote-exec");
  });
});

describe("bundledRemoteExec", () => {
  it("serves and hashes each architecture's bytes", async () => {
    const x86 = new TextEncoder().encode("x86 build");
    const arm = new TextEncoder().encode("arm build");
    const binaries = bundledRemoteExec({
      x86_64: x86.buffer as ArrayBuffer,
      aarch64: arm.buffer as ArrayBuffer,
    });
    expect(await binaries.sha256("x86_64")).toBe(await sha256(x86));
    expect(await binaries.sha256("aarch64")).toBe(await sha256(arm));
    expect(await new Response(await binaries.open("aarch64")).text()).toBe("arm build");
  });
});
