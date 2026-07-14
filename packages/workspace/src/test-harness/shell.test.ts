// Shell end-to-end harness. Same shape as end-to-end.test.ts —
// boots wsd via run-harness.sh, dials with TestBackend, drives
// Workspace.shell against the real container.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { withWorkspace } from "./with-workspace.js";

interface HarnessEnv {
  WSD_HARNESS_URL: string;
}

const url = (env as HarnessEnv).WSD_HARNESS_URL;
const describeIfDocker = url.length > 0 ? describe : describe.skip;

describeIfDocker("Workspace.shell against a real wsd container", () => {
  it("exec captures stdout and exit code (utf8)", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const handle = await ws.shell.exec("echo hello && exit 7", {
        encoding: "utf8",
      });
      const { exitCode, stdout, stderr } = await handle.result();
      expect(stdout).toBe("hello\n");
      expect(stderr).toBe("");
      expect(exitCode).toBe(7);
    });
  });

  it("exec captures stdout as Uint8Array by default", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const handle = await ws.shell.exec("printf bytes");
      const { stdout } = await handle.result();
      expect(stdout).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(stdout as Uint8Array)).toBe("bytes");
    });
  });

  it("kill terminates a running command (SIGTERM → 143)", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const handle = await ws.shell.exec("sleep 30", {
        id: "killme",
        encoding: "utf8",
      });
      await handle.kill();
      const { exitCode } = await handle.result();
      expect(exitCode).toBe(143);
    });
  });

  it("get() replays a finished run by seq cursor", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const first = await ws.shell.exec("printf 'a\\nb\\nc\\n'", {
        id: "replay",
        encoding: "utf8",
      });
      const original = await first.result();
      expect(original.exitCode).toBe(0);

      const reattach = await ws.shell.get("replay", {
        encoding: "utf8",
        resume: "full",
      });
      const again = await reattach.result();
      expect(again.stdout).toBe(original.stdout);
      expect(again.exitCode).toBe(original.exitCode);
    });
  });

  it("streaming iteration sees stdout chunks in order", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      const handle = await ws.shell.exec("printf one; printf two; printf three", {
        encoding: "utf8",
      });
      const chunks: string[] = [];
      let exitCode = -1;
      const reader = handle.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.name === "stdout") chunks.push(value.value);
          else if (value.name === "exit") exitCode = value.value;
        }
      } finally {
        reader.releaseLock();
      }
      expect(chunks.join("")).toBe("onetwothree");
      expect(exitCode).toBe(0);
    });
  });

  it("exec result.pulled counts wsd revs that landed during the run", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      // Touch wsd via the FUSE mount so currentRev advances
      // during the exec. Each `touch` is one applyChanges round
      // on the server, which bumps the rev exactly once.
      const handle = await ws.shell.exec(
        "touch /workspace/bracket-a && touch /workspace/bracket-b && touch /workspace/bracket-c",
        { encoding: "utf8" },
      );
      const result = await handle.result();
      expect(result.exitCode).toBe(0);
      expect(result.pushed).toBe(0);
      // At least one rev per touch. Concurrent host activity (none
      // here) could push it higher, so we assert the floor, not
      // an exact count.
      expect(result.pulled).toBeGreaterThanOrEqual(3);
    });
  });

  it("exec result.pulled is 0 for a command that does not touch the VFS", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      await ws.pull();
      const handle = await ws.shell.exec("echo cheap", { encoding: "utf8" });
      const result = await handle.result();
      expect(result.exitCode).toBe(0);
      expect(result.pulled).toBe(0);
    });
  });

  it("syncs repository outputs but ignores a generated dependency tree", async () => {
    await withWorkspace(url, async (ws) => {
      await ws.ready();
      await ws.pull();
      const root = `/workspace/repo-${crypto.randomUUID()}`;
      await ws.fs.mkdir(`${root}/vendor/tiny`, { recursive: true });
      await ws.fs.writeFile(
        `${root}/package.json`,
        JSON.stringify({
          name: "sync-recovery-fixture",
          private: true,
          dependencies: { tiny: "file:vendor/tiny" },
        }),
      );
      await ws.fs.writeFile(`${root}/vendor/tiny/index.js`, "installed\n");

      const handle = await ws.shell.exec(
        "mkdir -p node_modules/tiny dist && " +
          "cp vendor/tiny/index.js node_modules/tiny/index.js && " +
          "cat node_modules/tiny/index.js > dist/result.txt",
        { cwd: root, encoding: "utf8" },
      );
      const result = await handle.result();

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.pulled).toBeGreaterThan(0);
      expect(await ws.fs.readFile(`${root}/dist/result.txt`, "utf8")).toBe("installed\n");
      await expect(ws.fs.stat(`${root}/node_modules`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }, 60_000);
});
