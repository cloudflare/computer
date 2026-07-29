import { describe, expect, it } from "vitest";

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY, decideApproval } from "./approval-policy.js";

// Shorthand: does this command need a human under the default policy?
function gates(command: string, backend: string, policy?: ApprovalPolicy): boolean {
  return decideApproval({ command, backend }, policy).needsApproval;
}

describe("decideApproval", () => {
  describe("the 'always' rule", () => {
    it("gates every command on the container backend", () => {
      expect(gates("cat /workspace/hello.txt", "container")).toBe(true);
      expect(gates("uname -a", "container")).toBe(true);
    });

    it("gates a command that the same rule set waves through on shell", () => {
      // Identical command, different backend: proves the rule is
      // per-backend rather than per-command.
      expect(gates("cat /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("cat /workspace/hello.txt", "container")).toBe(true);
    });
  });

  describe("the 'never' rule", () => {
    const trusting: ApprovalPolicy = { rules: { shell: "never" }, fallback: "always" };

    it("waves through even a destructive command", () => {
      expect(gates("rm -rf /workspace", "shell", trusting)).toBe(false);
    });
  });

  describe("unknown backends", () => {
    it("falls back to the strictest rule", () => {
      expect(gates("cat /workspace/hello.txt", "not-a-backend")).toBe(true);
    });

    it("honours an explicit fallback", () => {
      const lenient: ApprovalPolicy = { rules: {}, fallback: "never" };
      expect(gates("rm -rf /", "whatever", lenient)).toBe(false);
    });
  });

  describe("the 'read-only' rule on a shell dialect", () => {
    it("waves through recognized reads", () => {
      expect(gates("cat /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("ls -la /workspace", "shell")).toBe(false);
      expect(gates("grep -n needle /workspace/haystack.txt", "shell")).toBe(false);
      expect(gates("find /workspace -name '*.ts'", "shell")).toBe(false);
      expect(gates("wc -l /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("head -n 5 /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("stat /workspace/hello.txt", "shell")).toBe(false);
    });

    it("waves through read-only git plumbing", () => {
      expect(gates("git status", "shell")).toBe(false);
      expect(gates("git log --oneline -5", "shell")).toBe(false);
      expect(gates("git diff HEAD", "shell")).toBe(false);
    });

    it("gates git subcommands that write", () => {
      expect(gates("git commit -m wip", "shell")).toBe(true);
      expect(gates("git push origin main", "shell")).toBe(true);
      expect(gates("git checkout -b feature", "shell")).toBe(true);
      expect(gates("git", "shell")).toBe(true);
    });

    it("gates mutating commands", () => {
      expect(gates("rm -rf /workspace", "shell")).toBe(true);
      expect(gates("mv /workspace/a /workspace/b", "shell")).toBe(true);
      expect(gates("mkdir -p /workspace/deep/dir", "shell")).toBe(true);
      expect(gates("chmod 777 /workspace/hello.txt", "shell")).toBe(true);
      expect(gates("npm install", "shell")).toBe(true);
    });

    it("gates redirection, even of a read", () => {
      expect(gates("cat /workspace/a > /workspace/b", "shell")).toBe(true);
      expect(gates("cat /workspace/a >> /workspace/b", "shell")).toBe(true);
      expect(gates("cat < /workspace/a", "shell")).toBe(true);
    });

    it("gates composition, even of two reads", () => {
      // A pipeline of reads is harmless, but allowing composition
      // means auditing every element; the gate stays closed instead.
      expect(gates("cat /workspace/a | grep needle", "shell")).toBe(true);
      expect(gates("ls /workspace; rm -rf /workspace", "shell")).toBe(true);
      expect(gates("ls /workspace && rm -rf /workspace", "shell")).toBe(true);
      expect(gates("ls /workspace || true", "shell")).toBe(true);
      expect(gates("ls /workspace &", "shell")).toBe(true);
    });

    it("gates command substitution", () => {
      expect(gates("cat $(ls /workspace)", "shell")).toBe(true);
      expect(gates("cat `ls /workspace`", "shell")).toBe(true);
      expect(gates("cat /workspace/$(whoami)", "shell")).toBe(true);
    });

    it("gates a newline that hides a second command", () => {
      expect(gates("ls /workspace\nrm -rf /workspace", "shell")).toBe(true);
    });

    it("gates a read verb handed a flag that writes", () => {
      // A verb allowlist is not enough on its own: several read
      // commands write when given the right flag, so an unrecognized
      // flag on a read verb has to gate too.
      expect(gates("find /workspace -mindepth 1 -delete", "shell")).toBe(true);
      expect(gates("find /workspace -name x -exec rm {} +", "shell")).toBe(true);
      expect(gates("find /workspace -execdir rm {} +", "shell")).toBe(true);
      expect(gates("find /workspace -fprint /workspace/out", "shell")).toBe(true);
      expect(gates("sort -o /workspace/out /workspace/in", "shell")).toBe(true);
      expect(gates("sort --output=/workspace/out /workspace/in", "shell")).toBe(true);
    });

    it("still waves through the read flags those verbs are used with", () => {
      expect(gates("find /workspace -name '*.ts'", "shell")).toBe(false);
      expect(gates("find /workspace -type f -maxdepth 2", "shell")).toBe(false);
      expect(gates("find /workspace -mtime -1", "shell")).toBe(false);
      expect(gates("sort -n /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("sort -u -r /workspace/hello.txt", "shell")).toBe(false);
    });

    it("gates an unrecognized flag on a checked verb", () => {
      expect(gates("find /workspace -frobnicate", "shell")).toBe(true);
    });

    it("gates verbs whose writing cannot be told from their arguments", () => {
      // sed writes through -i and through a `w` command inside the
      // script, which a matcher cannot reliably find. uniq and tree
      // take an output file as a positional argument, and date -s sets
      // the clock. None of them are worth the false confidence, so
      // none of them are recognized reads.
      expect(gates("sed s/a/b/ /workspace/hello.txt", "shell")).toBe(true);
      expect(gates("sed -i s/a/b/ /workspace/hello.txt", "shell")).toBe(true);
      expect(gates("sed 'w /workspace/out' /workspace/hello.txt", "shell")).toBe(true);
      expect(gates("uniq /workspace/in /workspace/out", "shell")).toBe(true);
      expect(gates("tree -o /workspace/out", "shell")).toBe(true);
      expect(gates("date -s 12:00", "shell")).toBe(true);
    });

    it("strips leading environment assignments before reading the verb", () => {
      expect(gates("LC_ALL=C sort /workspace/hello.txt", "shell")).toBe(false);
      expect(gates("LC_ALL=C rm /workspace/hello.txt", "shell")).toBe(true);
    });

    it("gates an unrecognized command rather than guessing", () => {
      expect(gates("frobnicate --hard", "shell")).toBe(true);
      expect(gates("", "shell")).toBe(true);
      expect(gates("   ", "shell")).toBe(true);
    });
  });

  describe("the 'read-only' rule on the codemode dialect", () => {
    it("waves through a snippet that only reads", () => {
      expect(gates('return await state.readFile("/workspace/hello.txt");', "codemode")).toBe(false);
      expect(gates('const s = await state.stat("/workspace"); return s.size;', "codemode")).toBe(
        false,
      );
      expect(gates('return (await state.readdir("/workspace")).length;', "codemode")).toBe(false);
    });

    it("waves through a snippet that never touches state", () => {
      // The sandbox has no network and no other reach into the store,
      // so a snippet without state.* can only compute.
      expect(gates("return 2 + 2;", "codemode")).toBe(false);
    });

    it("gates a snippet that mutates", () => {
      expect(gates('await state.writeFile("/workspace/x", "hi");', "codemode")).toBe(true);
      expect(gates('await state.mkdir("/workspace/d", { recursive: true });', "codemode")).toBe(
        true,
      );
      expect(gates('await state.rm("/workspace/x", { force: true });', "codemode")).toBe(true);
      expect(gates('await state.chmod("/workspace/x", 0o755);', "codemode")).toBe(true);
      expect(gates('await state.symlink("/workspace/x", "/workspace/y");', "codemode")).toBe(true);
    });

    it("gates a mutation hidden behind a computed member access", () => {
      // The point of allowlisting reads instead of blocklisting
      // writes: a blocklist misses these, an allowlist does not.
      expect(gates('await state["writeFile"]("/workspace/x", "hi");', "codemode")).toBe(true);
      expect(
        gates('const m = "writeFile"; await state[m]("/workspace/x", "hi");', "codemode"),
      ).toBe(true);
      expect(gates('await state?.["writeFile"]("/workspace/x", "hi");', "codemode")).toBe(true);
    });

    it("gates a snippet that aliases state", () => {
      expect(gates('const { writeFile } = state; await writeFile("/x", "y");', "codemode")).toBe(
        true,
      );
      expect(gates("const s = state; return s;", "codemode")).toBe(true);
    });

    it("gates an unrecognized state member", () => {
      expect(gates("await state.frobnicate();", "codemode")).toBe(true);
    });

    it("waves through a read reached with optional chaining", () => {
      expect(gates('return await state?.readFile("/workspace/hello.txt");', "codemode")).toBe(
        false,
      );
    });

    it("does not apply shell rules to a JavaScript snippet", () => {
      // `>` is a comparison here, not a redirect, and `state.ls` is a
      // read. A shell-dialect check would gate this.
      expect(gates('return (await state.ls("/workspace")).length > 0;', "codemode")).toBe(false);
    });
  });

  describe("the decision itself", () => {
    it("explains every gate it raises", () => {
      const commands: Array<[string, string]> = [
        ["rm -rf /workspace", "shell"],
        ["cat /workspace/a > /workspace/b", "shell"],
        ["uname -a", "container"],
        ['await state.writeFile("/workspace/x", "hi");', "codemode"],
        ["frobnicate", "not-a-backend"],
      ];
      for (const [command, backend] of commands) {
        const decision = decideApproval({ command, backend });
        expect(decision.needsApproval).toBe(true);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });

    it("explains why it let a command through", () => {
      const decision = decideApproval({ command: "cat /workspace/hello.txt", backend: "shell" });
      expect(decision.needsApproval).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
    });

    it("names the backend rule in the reason, so the queue is readable", () => {
      expect(decideApproval({ command: "uname -a", backend: "container" }).reason).toContain(
        "container",
      );
    });

    it("is a pure function of command and backend", () => {
      // Approval survives a pause: the AI SDK re-runs the policy when
      // the turn resumes, and an approved call whose policy has since
      // flipped is converted to a denial. Same input, same answer,
      // every time.
      const call = { command: 'await state.writeFile("/workspace/x", "hi");', backend: "codemode" };
      const first = decideApproval(call);
      for (let i = 0; i < 5; i++) {
        expect(decideApproval(call)).toEqual(first);
      }
    });
  });

  describe("DEFAULT_APPROVAL_POLICY", () => {
    it("gates the container backend outright and reads nothing else", () => {
      expect(DEFAULT_APPROVAL_POLICY.rules).toEqual({
        shell: "read-only",
        codemode: "read-only",
        container: "always",
      });
      expect(DEFAULT_APPROVAL_POLICY.fallback).toBe("always");
    });
  });
});
