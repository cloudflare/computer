// Integration tests for KitebuildBackend in workerd: a real Kitebuild
// machine running BusyBox in the host Durable Object, with the
// Workspace store mounted at /workspace.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./kitebuild-backend-worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let counter = 0;
const host = () => env.HOST.get(env.HOST.idFromName(`case-${++counter}`));

describe("KitebuildBackend", () => {
  it("runs a pipeline in a BusyBox shell", async () => {
    const result = await host().exec(
      "printf 'b\\na\\nb\\n' | sort | uniq -c | sed 's/^ *//'; uname -m",
    );
    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "1 a\n2 b\nwasm32\n",
    });
  });

  it("reports exit codes and separates stderr", async () => {
    const result = await host().exec("echo out; echo err >&2; exit 3");
    expect(result).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  it("passes cwd, env and stdin", async () => {
    const result = await host().exec('pwd; echo "$CI $GREETING_TARGET"; tr a-z A-Z', {
      cwd: "/workspace",
      env: { GREETING_TARGET: "world" },
      stdin: "from stdin\n",
    });
    expect(result.stdout).toBe("/workspace\n1 world\nFROM STDIN\n");
  });

  it("shares files with the Workspace in both directions", async () => {
    const stub = host();
    await stub.writeFile("/workspace/in.txt", "from the agent\n");
    const result = await stub.exec(
      "cat in.txt; mkdir -p out/deep && echo from the shell > out/deep/f.txt && mv out/deep/f.txt out/g.txt && chmod 755 out/g.txt",
      { cwd: "/workspace" },
    );
    expect(result.stdout).toBe("from the agent\n");
    expect(await stub.readFile("/workspace/out/g.txt")).toBe("from the shell\n");
    expect(await stub.readFile("/workspace/out/deep/f.txt")).toBeNull();
    expect(await stub.mode("/workspace/out/g.txt")).toBe(0o755);
  });

  it("runs with a read-only mount inside /workspace, and refuses writes to it", async () => {
    const stub = host();
    await stub.withReadOnlyMount();
    const result = await stub.exec("cat ro/readme.txt && echo ok > note.txt && cat note.txt", {
      cwd: "/workspace",
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ro\nok\n" });
    const refused = await stub.exec("echo x > ro/new.txt", { cwd: "/workspace" });
    expect(refused.exitCode).not.toBe(0);
    expect(await stub.readFile("/workspace/ro/new.txt")).toBeNull();
  });

  it("sees Workspace writes made between commands", async () => {
    const stub = host();
    await stub.writeFile("/workspace/a.txt", "one");
    expect((await stub.exec("cat /workspace/a.txt")).stdout).toBe("one");
    await stub.writeFile("/workspace/a.txt", "two, longer");
    await stub.writeFile("/workspace/b.txt", "new");
    expect((await stub.exec("cat /workspace/a.txt; echo; ls /workspace")).stdout).toBe(
      "two, longer\na.txt\nb.txt\n",
    );
  });

  it("sees Workspace writes made while a command runs", async () => {
    const stub = host();
    await stub.writeFile("/workspace/a.txt", "one");
    expect((await stub.exec("cat /workspace/a.txt")).stdout).toBe("one");
    // The command writes a file of its own while the host writes others.
    const running = stub.exec("echo mine > /workspace/c.txt; sleep 1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stub.writeFile("/workspace/a.txt", "two, longer");
    await stub.writeFile("/workspace/b.txt", "new");
    await running;
    expect(
      (
        await stub.exec("cat /workspace/a.txt; echo; cat c.txt; ls /workspace", {
          cwd: "/workspace",
        })
      ).stdout,
    ).toBe("two, longer\nmine\na.txt\nb.txt\nc.txt\n");
  });

  it.each([
    ["touch a.txt", "two, longer"],
    ["chmod 600 a.txt", "two, longer"],
    ["mv a.txt moved.txt && mv moved.txt a.txt", "two, longer"],
  ])(
    "sees an outside write to a file the command then changes with %s",
    async (change, expected) => {
      const stub = host();
      await stub.writeFile("/workspace/a.txt", "one");
      expect((await stub.exec("cat /workspace/a.txt")).stdout).toBe("one");
      const running = stub.exec(`sleep 1; ${change}`, { cwd: "/workspace" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await stub.writeFile("/workspace/a.txt", "two, longer");
      await running;
      expect((await stub.exec("cat a.txt", { cwd: "/workspace" })).stdout).toBe(expected);
    },
  );

  it("stops background jobs when the Workspace closes", async () => {
    const stub = host();
    // A directory is created at once, not buffered until the next flush,
    // so it shows whether the job ran on after the close.
    const result = await stub.exec("(sleep 1; mkdir /workspace/late) &", { cwd: "/workspace" });
    expect(result.exitCode).toBe(0);
    await stub.closeAndReopen();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await stub.exists("/workspace/late")).toBe(false);
  });

  it("extracts and checks an archive round trip", async () => {
    const stub = host();
    const result = await stub.exec(
      "mkdir -p src && for i in $(seq 1 50); do echo file $i > src/f$i.txt; done && " +
        "tar czf src.tgz src && rm -rf src && tar xzf src.tgz && cat src/f*.txt | wc -l && md5sum src/f7.txt",
      { cwd: "/workspace" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^50\n[0-9a-f]{32} {2}src\/f7.txt\n$/);
    expect(await stub.readFile("/workspace/src/f50.txt")).toBe("file 50\n");
  });

  it("streams output while the command runs", async () => {
    const events = await host().events("echo first; sleep 1; echo second");
    expect(events.map((event) => [event.name, event.text])).toEqual([
      ["stdout", "first\n"],
      ["stdout", "second\n"],
      ["exit", "0"],
    ]);
    expect(events[1].ms - events[0].ms).toBeGreaterThanOrEqual(900);
  });

  it("coalesces a burst of small writes into a few events", async () => {
    const events = await host().events("for i in $(seq 1 500); do echo $i; done");
    const output = events.filter((event) => event.name === "stdout");
    expect(output.map((event) => event.text).join("")).toBe(
      Array.from({ length: 500 }, (_, i) => `${i + 1}\n`).join(""),
    );
    expect(output.length).toBeLessThan(10);
  });

  it("keeps the order of stdout and stderr when coalescing", async () => {
    const events = await host().events("echo a; echo b; echo c >&2; echo d");
    expect(events.map((event) => [event.name, event.text])).toEqual([
      ["stdout", "a\nb\n"],
      ["stderr", "c\n"],
      ["stdout", "d\n"],
      ["exit", "0"],
    ]);
  });

  it("stops a command on kill", async () => {
    const result = await host().killAfter("echo started; sleep 30; echo never", 300, "SIGKILL");
    expect(result.stdout).toBe("started\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  });

  it("stops a command at its timeout", async () => {
    const result = await host().exec("sleep 30", { timeoutMs: 200 });
    expect(result.exitCode).not.toBe(0);
  });

  it("replays a finished execution by id", async () => {
    const stub = host();
    await stub.exec("echo kept", { id: "run-1" });
    expect((await stub.replay("run-1")).stdout).toBe("kept\n");
  });

  it("replays a finished execution after the Durable Object restarts", async () => {
    const stub = host();
    await stub.exec("echo kept; echo warned >&2; exit 3", { id: "run-2" });
    await stub.restart();
    expect(await stub.replay("run-2")).toMatchObject({
      exitCode: 3,
      stdout: "kept\n",
      stderr: "warned\n",
    });
  });

  it("settles a command the restart interrupted as failed", async () => {
    const stub = host();
    await stub.start("echo started; sleep 30", "run-3");
    await stub.restart();
    expect(await stub.replay("run-3")).toMatchObject({
      exitCode: 1,
      stdout: "started\n",
      stderr: "kitebuild: the command stopped when its Durable Object restarted\n",
    });
  });

  it("drops output past 8 MiB, live and on replay, and still reports the exit", async () => {
    const stub = host();
    const note = "kitebuild: output past 8388608 bytes was dropped\n";
    const result = await stub.exec("head -c 9000000 /dev/zero | tr '\\0' x; exit 4", {
      id: "run-big",
    });
    expect(result).toMatchObject({ exitCode: 4, stderr: note });
    const saved = result.truncated?.stdout;
    const kept = saved?.status === "saved" ? saved.totalBytes : 0;
    expect(kept).toBe(8 * 1024 * 1024);
    expect(await stub.replay("run-big")).toMatchObject({ exitCode: 4, stderr: note });
  });

  it("forgets a disposed execution, including after a restart", async () => {
    const stub = host();
    await stub.exec("echo gone", { id: "run-4" });
    await stub.dispose("run-4");
    await stub.restart();
    expect(await stub.replayError("run-4")).toBe("ENOENT");
  });

  describe("git", () => {
    const identity = {
      GIT_AUTHOR_NAME: "Ada",
      GIT_AUTHOR_EMAIL: "ada@example.com",
      GIT_COMMITTER_NAME: "Ada",
      GIT_COMMITTER_EMAIL: "ada@example.com",
    };

    it("runs Kitebuild's git by default", async () => {
      const stub = host();
      const result = await stub.exec(
        "mkdir repo && cd repo && git init -q && echo hi > a.txt && git add a.txt && " +
          "git commit -q -m first >/dev/null && git log --oneline | wc -l && git rev-parse --abbrev-ref HEAD",
        { cwd: "/workspace", env: identity },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "1\nmain\n" });
      // The machine's files are the Workspace's, so the agent sees the repo.
      expect(await stub.readFile("/workspace/repo/.git/HEAD")).toBe("ref: refs/heads/main\n");
    });

    it("commits as the Workspace's default identity when git finds none, and as the repo's own otherwise", async () => {
      const result = await host().exec(
        "git init -q r && cd r && echo hi > a && git add a && git commit -q -m first && git log -1 | grep Author && " +
          "git config user.name Local && git config user.email local@example.com && " +
          "echo more >> a && git commit -qam second && git log -1 | grep Author",
        { cwd: "/workspace" },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "Author: Workspace <workspace@example.com>\nAuthor: Local <local@example.com>\n",
      });
    });

    it("commits files the same command wrote", async () => {
      const result = await host().exec(
        "git init -q r && cd r && printf 'one\\ntwo\\n' > notes.txt && git add notes.txt && " +
          "git commit -q -m notes >/dev/null && echo three >> notes.txt && git status",
        { cwd: "/workspace", env: identity },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/modified:\s+notes\.txt/);
    });

    it("has no network for git under the default egress", async () => {
      const result = await host().exec("git clone https://github.com/honojs/starter app", {
        cwd: "/workspace",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("egress policy denied GET https://github.com/honojs/starter");
    });

    it("refuses git's requests under the default egress before the given fetch sees them", async () => {
      const stub = host();
      const result = await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitfetch",
        cwd: "/workspace",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("egress policy denied");
      expect(await stub.gitFetchRequests()).toEqual([]);
    });

    it("puts the given fetch in front of git's requests under direct egress", async () => {
      const stub = host();
      await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitdirect",
        cwd: "/workspace",
      });
      expect(await stub.gitFetchRequests()).toEqual([
        "https://git.example.test/repo.git/info/refs?service=git-upload-pack",
      ]);
    });

    it("sends git's requests through an http-gateway, with the given fetch in front", async () => {
      const stub = host();
      await stub.exec("git clone https://git.example.test/repo.git", {
        backend: "gitgateway",
        cwd: "/workspace",
      });
      expect(await stub.gitFetchResponses()).toEqual([
        "gateway saw GET https://git.example.test/repo.git/info/refs?service=git-upload-pack\n",
      ]);
    });

    it("pushes through the gateway", async () => {
      const stub = host();
      await stub.exec(
        "git init -q r && cd r && echo hi > a && git add a && git commit -q -m first >/dev/null && " +
          "git remote add origin https://git.example.test/repo.git && git push -u origin main",
        { backend: "gitgateway", cwd: "/workspace", env: identity },
      );
      expect(await stub.gitFetchResponses()).toEqual([
        "gateway saw GET https://git.example.test/repo.git/info/refs?service=git-receive-pack\n",
      ]);
    });

    it("runs the Workspace's git client when asked", async () => {
      const stub = host();
      const result = await stub.exec(
        "mkdir repo && cd repo && git init >/dev/null && echo hi > a.txt && git add a.txt && " +
          "git commit -m first >/dev/null && git log --oneline | wc -l && test -f .git/HEAD && echo has-head",
        { backend: "wsgit", cwd: "/workspace", env: identity },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "1\nhas-head\n" });
    });

    it("passes long output of the Workspace's git through a pipe whole", async () => {
      const result = await host().exec(
        // Filling a committed empty file gives a diff that is quick to
        // compute and larger than a pipe holds.
        "mkdir repo && cd repo && git init >/dev/null && : > big && git add big && " +
          "git commit -m empty >/dev/null && seq 1 20000 > big && " +
          "git diff > ../all.txt; echo $(wc -c < ../all.txt) $(git diff | wc -c)",
        { backend: "wsgit", cwd: "/workspace", env: identity },
      );
      const [toFile, toPipe] = result.stdout.trim().split(" ").map(Number);
      expect(toFile).toBeGreaterThan(65_536);
      expect(toPipe).toBe(toFile);
    });

    it("gives the Workspace's git its stdin", async () => {
      const result = await host().exec("printf hello | git hash-object --stdin", {
        backend: "wsgit",
        cwd: "/workspace",
      });
      // git hash-object of "hello", as real git prints it.
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0\n",
      });
    });

    it("does not run the Workspace's git when its stdin read is cut short", async () => {
      const stub = host();
      const git = { backend: "wsgit", cwd: "/workspace", env: identity };
      await stub.exec("git init -q .", git);
      const hello = "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0";
      const result = await stub.exec("(printf hello; sleep 30) | git hash-object -w --stdin", {
        ...git,
        timeoutMs: 500,
      });
      expect(result.exitCode).not.toBe(0);
      // The host's git would run after the machine stops the command.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect((await stub.exec(`git cat-file -t ${hello}`, git)).stdout).not.toContain("blob");
      // Run to the end, the same command writes the object.
      await stub.exec("printf hello | git hash-object -w --stdin", git);
      expect((await stub.exec(`git cat-file -t ${hello}`, git)).stdout).toBe("blob\n");
    });

    it("reports a Workspace without git", async () => {
      const result = await host().exec("git status", { backend: "nogit", cwd: "/workspace" });
      expect(result).toMatchObject({
        exitCode: 1,
        stderr: "git: Workspace git is not configured.\n",
      });
    });

    it("can be replaced by a toolset", async () => {
      const result = await host().exec("git status", { backend: "gateway" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "replaced /usr/bin/git\n" });
    });
  });

  it("runs programs from a toolset with its extras", async () => {
    expect((await host().exec("greet world")).stdout).toBe("hello world\n");
  });

  it("has no network by default", async () => {
    const result = await host().exec(
      "wget -q -O - http://192.0.2.1/ 2>&1; wget -q -O - http://example.com/ 2>&1",
    );
    expect(result.stdout).toContain("Permission denied");
    expect(result.stdout).toContain("bad address 'example.com'");
  });

  it("sends traffic through an http-gateway by host name", async () => {
    const result = await host().exec(
      "wget -q -O - http://example.com/plain; wget -q -O - https://example.com/secure",
      { backend: "gateway" },
    );
    expect(result.stdout).toBe(
      "gateway saw GET http://example.com/plain\ngateway saw GET https://example.com/secure\n",
    );
  });

  describe("assets", () => {
    it("publishes a file written earlier in the same command", async () => {
      const stub = host();
      // fd 3 stays open, so the file is still in a write buffer.
      const result = await stub.exec(
        "exec 3> out.txt && printf 'fresh bytes' >&3 && assets publish out.txt 5m",
        { cwd: "/workspace" },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "https://assets.example/out.txt\n",
        stderr: "",
      });
      expect((await stub.records()).published).toEqual([
        { path: "/workspace/out.txt", expiresAfter: 5 * 60_000, body: "fresh bytes" },
      ]);
    });

    it("reports a Workspace without an assets client", async () => {
      const stub = host();
      await stub.writeFile("/workspace/out.txt", "x");
      const result = await stub.exec("assets publish /workspace/out.txt", { backend: "fakes" });
      expect(result).toMatchObject({
        exitCode: 1,
        stdout: "",
        stderr: "assets: publishing is not configured for this workspace\n",
      });
    });

    it("can be replaced by a toolset", async () => {
      const result = await host().exec("assets publish /workspace/out.txt", { backend: "gateway" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "replaced /usr/bin/assets\n" });
    });

    it("prints usage for bad arguments", async () => {
      const stub = host();
      for (const command of ["assets", "assets publish", "assets nope x", "assets publish x 5y"]) {
        const result = await stub.exec(command);
        expect(result.exitCode, command).toBe(2);
        expect(result.stdout, command).toBe("");
      }
      expect((await stub.exec("assets publish")).stderr).toBe(
        "usage: assets publish <path> [<expiry>]\n",
      );
      expect((await stub.exec("assets publish x 5y")).stderr).toBe('assets: invalid expiry "5y"\n');
      expect((await stub.records()).published).toEqual([]);
    });
  });

  describe("artifacts", () => {
    it("forwards argv and env to the artifacts client", async () => {
      const stub = host();
      const result = await stub.exec("TOKEN=t artifacts repo list --json", {
        backend: "fakes",
        env: { CI: "1" },
      });
      expect(result).toMatchObject({ exitCode: 4, stdout: "", stderr: "artifacts: failed\n" });
      const [call] = (await stub.records()).artifacts;
      expect(call.argv).toEqual(["repo", "list", "--json"]);
      expect(call.env).toMatchObject({ CI: "1", TOKEN: "t", HOME: "/root" });
    });

    it("shows the remote create adds to the rest of the command", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const result = await stub.exec(
        "cat remotes.txt && artifacts create demo && cat remotes.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "none\ncreated demo\norigin https://x/repo.git\n",
      });
    });

    it("shows the remote at once while another command is running", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const [, during] = await stub.overlapping(
        "sleep 2",
        "cat remotes.txt && artifacts create demo && cat remotes.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(during.stdout).toBe("none\ncreated demo\norigin https://x/repo.git\n");
    });

    it("keeps a descriptor opened before the change writable", async () => {
      const stub = host();
      await stub.writeFile("/workspace/repo/remotes.txt", "none\n");
      const result = await stub.exec(
        "{ echo before; artifacts create demo; echo after; } > log.txt; cat log.txt",
        { backend: "fakes", cwd: "/workspace/repo" },
      );
      expect(result).toMatchObject({ exitCode: 0, stdout: "before\ncreated demo\nafter\n" });
      expect(await stub.readFile("/workspace/repo/log.txt")).toBe("before\ncreated demo\nafter\n");
    });
  });

  // The cases of tests/worker-backend.test.ts, which runs the Worker
  // shell end to end, against this backend.
  describe("the Worker shell's end-to-end cases", () => {
    it("round-trips a file through the host and reads it back in the shell", async () => {
      const stub = host();
      await stub.writeFile("/workspace/hello.txt", "hello from the host");
      const result = await stub.exec("cat hello.txt", { cwd: "/workspace" });
      expect(result).toMatchObject({ exitCode: 0, stdout: "hello from the host", stderr: "" });
    });

    it("sees writes from the shell on later host reads", async () => {
      const stub = host();
      const result = await stub.exec("echo 'from inside the shell' > greeting.txt", {
        cwd: "/workspace",
      });
      expect(result.exitCode).toBe(0);
      expect(await stub.readFile("/workspace/greeting.txt")).toBe("from inside the shell\n");
    });

    it("moves a file with mv rather than copying it", async () => {
      const stub = host();
      await stub.writeFile("/workspace/old.txt", "payload");
      const result = await stub.exec("mv old.txt new.txt && cat new.txt && test -e old.txt", {
        cwd: "/workspace",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("payload");
      expect(await stub.readFile("/workspace/new.txt")).toBe("payload");
    });

    it("keeps the last 2000 lines of long output and saves the rest to a file", async () => {
      const stub = host();
      const result = await stub.exec("seq 1 5000");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.split("\n").slice(0, 2)).toEqual(["3001", "3002"]);
      expect(result.stdout.endsWith("5000\n")).toBe(true);
      expect(result.truncated?.stdout).toMatchObject({ status: "saved", totalLines: 5000 });
      const saved = result.truncated?.stdout;
      const full = await stub.readFile(saved?.status === "saved" ? saved.path : "");
      expect(full?.split("\n").length).toBe(5001);
      expect(full?.startsWith("1\n2\n3\n")).toBe(true);
    });

    it("carries on past a failing command with its stderr captured", async () => {
      const result = await host().exec("ls /nope 2>&1; echo done");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/No such file or directory\ndone/);
    });

    // The Worker shell checks its opt-in curl group is registered.
    // BusyBox has no curl; its HTTP client is wget.
    it("has an HTTP client, BusyBox's wget", async () => {
      const result = await host().exec("wget 2>&1; echo done");
      expect(result.stdout).toMatch(/Usage: wget/);
      expect(result.stdout).toMatch(/done/);
    });

    it("keeps separate Workspaces apart", async () => {
      const [a, b] = [host(), host()];
      await a.writeFile("/workspace/owner.txt", "alice");
      await b.writeFile("/workspace/owner.txt", "bob");
      const out = await Promise.all([
        a.exec("cat owner.txt", { cwd: "/workspace" }),
        b.exec("cat owner.txt", { cwd: "/workspace" }),
      ]);
      expect(out.map((result) => result.stdout)).toEqual(["alice", "bob"]);
    });
  });
});
