/**
 * End to end against the real remote-exec binary, with local processes standing in for the
 * container: remoteExec() as the Durable Object calls it, through session, run, push and pull.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteExec } from "./exec";
import { RemoteExecError } from "./session";
import {
  alive,
  BIN,
  eventually,
  finish,
  harness,
  tree,
  write,
  type Harness,
} from "./testing/harness";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.cleanup();
});

describe("remote exec", () => {
  it("pushes selected files, honouring .gitignore, and runs with raw stdio", async () => {
    await write(h.ws, {
      ".gitignore": "dist/\n*.log\n",
      "src/a.txt": "alpha\n",
      "src/b.txt": "beta\n",
      "src/debug.log": "noise",
      "dist/out.js": "built",
      "notes.md": "not selected",
    });
    const proc = await remoteExec(h.config, ["sh", "-c", "cat src/a.txt; echo oops >&2; exit 3"], {
      push: ["src/**", ".gitignore"],
      cwd: "/workspace",
    });
    const result = await finish(proc);
    expect(result).toMatchObject({ stdout: "alpha\n", stderr: "oops\n", exitCode: 3 });
    expect(proc.pushed).toMatchObject({ status: "done", files: 3, transferred: 3 });
    expect(await tree(h.ctr)).toEqual([".gitignore", "src/a.txt", "src/b.txt"]);
  });

  it("only sends changed files on the next push, and deletes what an earlier push placed", async () => {
    await write(h.ws, { "src/a.txt": "1", "src/b.txt": "2" });
    await finish(await remoteExec(h.config, ["true"], { push: ["src/**"] }));
    await write(h.ctr, { "src/made-in-container.txt": "keep me" });
    await fsp.rm(path.join(h.ws, "src/b.txt"));
    await write(h.ws, { "src/a.txt": "1 changed" });
    const proc = await remoteExec(h.config, ["true"], { push: ["src/**"] });
    await finish(proc);
    expect(proc.pushed).toMatchObject({ files: 1, transferred: 1, deleted: ["src/b.txt"] });
    expect(await tree(h.ctr)).toEqual(["src/a.txt", "src/made-in-container.txt"]);
    expect(await fsp.readFile(path.join(h.ctr, "src/a.txt"), "utf8")).toBe("1 changed");
  });

  it("pulls back what the command changed, including deletions, and nothing else", async () => {
    await write(h.ws, {
      "src/keep.txt": "same",
      "src/edit.txt": "before",
      "src/gone.txt": "bye",
      ".gitignore": "node_modules/\n",
    });
    const proc = await remoteExec(
      h.config,
      [
        "sh",
        "-c",
        "echo after > src/edit.txt; rm src/gone.txt; mkdir -p out node_modules/x; echo new > out/new.txt; echo dep > node_modules/x/i.js",
      ],
      { push: ["**"], pull: ["**"] },
    );
    const { exitCode, pulled } = await finish(proc);
    expect(exitCode).toBe(0);
    expect(pulled).toMatchObject({
      status: "done",
      files: 2,
      transferred: 2,
      deleted: ["src/gone.txt"],
      conflicts: [],
    });
    expect(await tree(h.ws)).toEqual([".gitignore", "out/new.txt", "src/edit.txt", "src/keep.txt"]);
    expect(await fsp.readFile(path.join(h.ws, "src/edit.txt"), "utf8")).toBe("after\n");
  });

  it("pipes stdin through", async () => {
    const proc = await remoteExec(h.config, ["sh", "-c", "tr a-z A-Z"], { stdin: "pipe" });
    if (!proc.stdin) throw new Error("no stdin");
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode("hello remote exec\n"));
    await writer.close();
    expect(await finish(proc)).toMatchObject({ stdout: "HELLO REMOTE EXEC\n", exitCode: 0 });
  });

  it("rejects exec() when the command can't start, like the platform", async () => {
    await expect(remoteExec(h.config, ["/no/such/binary"])).rejects.toMatchObject({
      name: "RemoteExecError",
      code: "spawn",
      errno: 2,
    });
    await expect(
      remoteExec(h.config, ["true"], { cwd: "/workspace/missing-dir" }),
    ).rejects.toBeInstanceOf(RemoteExecError);
  });

  it("reports the command's real pid and runs it in its own process group", async () => {
    const proc = await remoteExec(h.config, [
      "sh",
      "-c",
      "echo $$; ps -o pgid= -p $$ 2>/dev/null || cut -d' ' -f5 /proc/$$/stat",
    ]);
    const { stdout } = await finish(proc);
    const [pid, pgid] = stdout.trim().split(/\s+/).map(Number);
    expect(pid).toBe(proc.pid);
    expect(pgid).toBe(proc.pid);
  });

  it("kill() reaches everything the command started", async () => {
    await fsp.mkdir(h.ctr, { recursive: true });
    const proc = await remoteExec(h.config, [
      "sh",
      "-c",
      "sleep 1000 & echo $! > pids; setsid sleep 1000 & echo $! >> pids; wait",
    ]);
    await eventually(
      async () =>
        (await fsp.readFile(path.join(h.ctr, "pids"), "utf8").catch(() => "")).trim().split("\n")
          .length === 2,
    );
    const pids = (await fsp.readFile(path.join(h.ctr, "pids"), "utf8"))
      .trim()
      .split("\n")
      .map(Number);
    proc.kill();
    const { exitCode } = await finish(proc);
    expect(exitCode).toBe(143);
    await eventually(() => pids.every((p) => !alive(p)));
  });

  it("ends background processes when the command exits", async () => {
    await fsp.mkdir(h.ctr, { recursive: true });
    const proc = await remoteExec(h.config, [
      "sh",
      "-c",
      "setsid sh -c 'sleep 1000' & echo $! > bg; exit 0",
    ]);
    expect((await finish(proc)).exitCode).toBe(0);
    const pid = Number(await fsp.readFile(path.join(h.ctr, "bg"), "utf8"));
    await eventually(() => !alive(pid));
  });

  it("an abort SIGKILLs the command and skips pull", async () => {
    const controller = new AbortController();
    const proc = await remoteExec(h.config, ["sleep", "1000"], {
      pull: ["**"],
      signal: controller.signal,
    });
    controller.abort();
    const { exitCode, pulled } = await finish(proc);
    expect(exitCode).toBe(137);
    expect(pulled.status).toBe("skipped");
  });

  it("runs syncing calls one at a time, each pulling only its own changes", async () => {
    await fsp.mkdir(path.join(h.ws, "out"), { recursive: true });
    const a = remoteExec(h.config, ["sh", "-c", "sleep 0.4; mkdir -p out; echo A > out/a.txt"], {
      push: ["out/**"],
      pull: ["out/**"],
    });
    await new Promise((r) => setTimeout(r, 100));
    const b = remoteExec(h.config, ["sh", "-c", "mkdir -p out; echo B > out/b.txt"], {
      push: ["out/**"],
      pull: ["out/**"],
    });
    const [ra, rb] = await Promise.all([a.then(finish), b.then(finish)]);
    const [pa, pb] = [await a, await b];
    expect(ra.pulled.files).toBe(1);
    expect(rb.pulled.files).toBe(1);
    expect(pb.pushed.lockWaitMs).toBeGreaterThan(200);
    expect(pa.pushed.lockWaitMs).toBeLessThan(200);
    expect(await tree(h.ws)).toEqual(["out/a.txt", "out/b.txt"]);
  });

  it("cleans up when the host goes away: command killed, socket gone, lock free", async () => {
    await fsp.mkdir(h.ctr, { recursive: true });
    const proc = await remoteExec(h.config, ["sh", "-c", "echo $$ > leader; sleep 1000"], {
      pull: ["**"],
    });
    await eventually(() => existsSync(path.join(h.ctr, "leader")));
    // The Durable Object dying closes the session's stdin; do exactly that.
    const session = h.target.children.find(({ cmd }) => cmd[1] === "session");
    session?.child.stdin?.end();
    expect(await proc.exitCode.catch((e: { exitCode?: number }) => e.exitCode)).toBe(137);
    expect(alive(proc.pid)).toBe(false);
    await eventually(async () => (await fsp.readdir(path.join(h.base, "run"))).length === 0);
    const next = await remoteExec(h.config, ["true"], { pull: ["**"], lockTimeoutMs: 1000 });
    await finish(next);
    expect(next.pushed.lockWaitMs).toBeLessThan(100);
  });

  it("refuses a run with the wrong token", async () => {
    // Start a session by hand and attach with a bogus token.
    const proc = await h.target.exec([BIN, "run", "--session", "nosuch", "--token", "00"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exitCode).toBe(125);
  });

  // Switching user needs root, which CI's images don't run as.
  it.skipIf(process.getuid?.() !== 0)(
    "runs as the given user and chowns pushed files",
    async () => {
      await write(h.ws, { "a.txt": "x" });
      await fsp.chmod(h.base, 0o755);
      const proc = await remoteExec(h.config, ["sh", "-c", "id -u; id -g; stat -c %u:%g a.txt"], {
        push: ["a.txt"],
        user: "1000:1001",
      });
      const { stdout, exitCode } = await finish(proc);
      expect(exitCode).toBe(0);
      expect(stdout.trim().split("\n")).toEqual(["1000", "1001", "1000:1001"]);
    },
  );

  it("pushes and pulls large and empty files, keeping modes", async () => {
    const big = "0123456789abcdef".repeat(200_000); // 3.2 MB: several chunks
    await write(h.ws, { "big.bin": big, "empty.txt": "", "run.sh": "#!/bin/sh\necho ran\n" });
    await fsp.chmod(path.join(h.ws, "run.sh"), 0o755);
    const proc = await remoteExec(
      h.config,
      ["sh", "-c", "./run.sh; wc -c < big.bin; cp big.bin big2.bin; : > empty2.txt"],
      {
        push: ["*"],
        pull: ["*"],
      },
    );
    const { stdout, exitCode } = await finish(proc);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual(["ran", String(big.length)]);
    expect(await fsp.readFile(path.join(h.ws, "big2.bin"), "utf8")).toBe(big);
    expect(await fsp.readFile(path.join(h.ws, "empty2.txt"), "utf8")).toBe("");
  });

  it("pulls modes back: new executables, and chmods that change nothing else", async () => {
    await write(h.ws, { "flip.sh": "#!/bin/sh\n", "plain.txt": "x\n" });
    await fsp.chmod(path.join(h.ws, "flip.sh"), 0o755);
    const proc = await remoteExec(
      h.config,
      [
        "sh",
        "-c",
        "printf '#!/bin/sh\\n' > made.sh; chmod 755 made.sh; chmod 644 flip.sh; chmod 700 plain.txt",
      ],
      { push: ["*"], pull: ["*"] },
    );
    expect((await finish(proc)).exitCode).toBe(0);
    const mode = async (name: string) => (await fsp.stat(path.join(h.ws, name))).mode & 0o777;
    expect(await mode("made.sh")).toBe(0o755);
    expect(await mode("flip.sh")).toBe(0o644);
    expect(await mode("plain.txt")).toBe(0o700);
  });

  it("syncs dot-directories and nested git repositories both ways, .git included", async () => {
    await write(h.ws, {
      "comp/package.json": "{}\n",
      "comp/.changeset/one.md": "a change\n",
      "comp/.github/workflows/ci.yml": "on: push\n",
      "comp/.gitignore": "node_modules/\n",
      "comp/src/x.ts": "x\n",
    });
    execFileSync("git", ["init", "-q", path.join(h.ws, "comp")]);
    const proc = await remoteExec(
      h.config,
      [
        "sh",
        "-c",
        "find comp -type f -not -path 'comp/.git/*' | sort; test -f comp/.git/HEAD && echo has-git; " +
          "echo two > comp/.changeset/two.md; " +
          "mkdir -p clone/.changeset && cd clone && git init -q && echo c > .changeset/c.md",
      ],
      { push: ["comp/**"], pull: ["comp/**", "clone/**"] },
    );
    const { stdout, exitCode } = await finish(proc);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      "comp/.changeset/one.md",
      "comp/.github/workflows/ci.yml",
      "comp/.gitignore",
      "comp/package.json",
      "comp/src/x.ts",
      "has-git",
    ]);
    expect(await fsp.readFile(path.join(h.ws, "comp/.changeset/two.md"), "utf8")).toBe("two\n");
    expect(await fsp.readFile(path.join(h.ws, "clone/.changeset/c.md"), "utf8")).toBe("c\n");
    expect(existsSync(path.join(h.ws, "clone/.git/HEAD"))).toBe(true);
  });

  it("takes globs relative to cwd", async () => {
    await write(h.ws, {
      "app/src/a.ts": "a\n",
      "app/package.json": "{}\n",
      "shared/s.ts": "s\n",
      "other/o.txt": "o\n",
    });
    const proc = await remoteExec(
      h.config,
      ["sh", "-c", "pwd; find .. -type f | sort; mkdir -p out && echo built > out/b.txt"],
      { cwd: "/workspace/app", push: ["**", "../shared/**"], pull: ["out/**"] },
    );
    const { stdout, exitCode } = await finish(proc);
    expect(exitCode).toBe(0);
    expect(stdout.trim().split("\n")).toEqual([
      path.join(h.ctr, "app"),
      "../app/package.json",
      "../app/src/a.ts",
      "../shared/s.ts",
    ]);
    expect(await fsp.readFile(path.join(h.ws, "app/out/b.txt"), "utf8")).toBe("built\n");
  });

  it("refuses globs outside the root", async () => {
    await expect(remoteExec(h.config, ["true"], { push: ["../etc/**"] })).rejects.toThrow(
      /isn't valid/,
    );
    await expect(remoteExec(h.config, ["true"], { pull: ["/etc/**"] })).rejects.toThrow(/outside/);
  });

  it("round-trips symlinks and deletes pushed ones the workspace removed", async () => {
    await write(h.ws, { "real.txt": "r" });
    await fsp.symlink("real.txt", path.join(h.ws, "link"));
    const first = await remoteExec(
      h.config,
      ["sh", "-c", "readlink link; ln -s real.txt made-link"],
      { push: ["**"], pull: ["**"] },
    );
    expect((await finish(first)).stdout).toBe("real.txt\n");
    expect(await fsp.readlink(path.join(h.ws, "made-link"))).toBe("real.txt");
    await fsp.rm(path.join(h.ws, "link"));
    const second = await remoteExec(h.config, ["true"], { push: ["**"] });
    await finish(second);
    expect(second.pushed.deleted).toContain("link");
    expect(existsSync(path.join(h.ctr, "link"))).toBe(false);
  });

  it("honours nested .gitignore files in both directions", async () => {
    await write(h.ws, {
      ".gitignore": "*.log\n",
      "pkg/.gitignore": "build/\n",
      "pkg/src.ts": "s",
      "pkg/build/out.js": "o",
      "a.log": "l",
    });
    const proc = await remoteExec(
      h.config,
      [
        "sh",
        "-c",
        "find . -type f | sort; mkdir -p pkg/build; echo x > pkg/build/new.js; echo y > new.log; echo z > pkg/kept.ts",
      ],
      {
        push: ["**"],
        pull: ["**"],
      },
    );
    const { stdout } = await finish(proc);
    expect(stdout.trim().split("\n")).toEqual(["./.gitignore", "./pkg/.gitignore", "./pkg/src.ts"]);
    expect(await tree(h.ws)).toEqual([
      ".gitignore",
      "a.log",
      "pkg/.gitignore",
      "pkg/build/out.js",
      "pkg/kept.ts",
      "pkg/src.ts",
    ]);
  });

  it("a call that can't get the lock in time fails with busy", async () => {
    const holder = await remoteExec(h.config, ["sleep", "2"], { pull: ["**"] });
    await expect(
      remoteExec(h.config, ["true"], { pull: ["**"], lockTimeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "busy" });
    // A call that syncs nothing doesn't wait for the lock at all.
    const free = await remoteExec(h.config, ["echo", "free"]);
    expect((await finish(free)).stdout).toBe("free\n");
    holder.kill(9);
    await finish(holder);
  });

  it("env is the image's over remote-exec's own, without its settings, under what was given", async () => {
    const proc = await remoteExec(
      h.config,
      ["sh", "-c", 'echo "$IMAGE_ONLY|$A|$HOME|$REMOTE_EXEC_STATE_DIR|"'],
      { env: { A: "1" } },
    );
    expect((await finish(proc)).stdout).toBe(`from the image|1|${process.env.HOME}||\n`);
    const unset = await remoteExec(h.config, ["sh", "-c", 'echo "$A"']);
    expect((await finish(unset)).stdout).toBe("image\n");
  });

  it("fails the call when the image's environment can't be read", async () => {
    const broken = await harness({ REMOTE_EXEC_IMAGE_ENV: "/nonexistent/environ" });
    try {
      await expect(remoteExec(broken.config, ["true"])).rejects.toThrow(
        /can't read the image's environment from \/nonexistent\/environ/,
      );
    } finally {
      await broken.cleanup();
    }
  });
});
