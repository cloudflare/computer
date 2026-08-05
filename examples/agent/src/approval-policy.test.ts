import { describe, expect, it } from "vitest";

import { type ApprovalPolicy, DEFAULT_APPROVAL_POLICY, decideApproval } from "./approval-policy.js";

// Shorthand: does this command need a human under the default policy?
function gates(command: string, backend: string, policy?: ApprovalPolicy): boolean {
  return decideApproval({ command, backend }, policy).needsApproval;
}

describe("decideApproval", () => {
  describe("the 'always' rule", () => {
    it("gates every command on the container backend", () => {
      expect(gates("cat /workspace/hello.txt", "container-shell")).toBe(true);
      expect(gates("uname -a", "container-shell")).toBe(true);
    });

    it("gates every module on the JavaScript backend", () => {
      // A module's effects are a function of what it imports and
      // computes, not of a verb at the front of a line. There is no
      // allowlist here to be conservative with.
      expect(gates("export default async () => 2 + 2;", "worker-javascript")).toBe(true);
    });

    it("gates a command that the same rule set waves through on the shell", () => {
      // Identical command, different backend: proves the rule is
      // per-backend rather than per-command.
      expect(gates("cat /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("cat /workspace/hello.txt", "container-shell")).toBe(true);
    });
  });

  describe("the 'never' rule", () => {
    const trusting: ApprovalPolicy = { rules: { "worker-shell": "never" }, fallback: "always" };

    it("waves through even a destructive command", () => {
      expect(gates("rm -rf /workspace", "worker-shell", trusting)).toBe(false);
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

  describe("the 'read-only' rule", () => {
    it("waves through recognized reads", () => {
      expect(gates("cat /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("ls -la /workspace", "worker-shell")).toBe(false);
      expect(gates("grep -n needle /workspace/haystack.txt", "worker-shell")).toBe(false);
      expect(gates("find /workspace -name '*.ts'", "worker-shell")).toBe(false);
      expect(gates("wc -l /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("head -n 5 /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("stat /workspace/hello.txt", "worker-shell")).toBe(false);
    });

    it("waves through read-only git plumbing", () => {
      expect(gates("git status", "worker-shell")).toBe(false);
      expect(gates("git log --oneline -5", "worker-shell")).toBe(false);
      expect(gates("git diff HEAD", "worker-shell")).toBe(false);
    });

    it("gates git subcommands that write", () => {
      expect(gates("git commit -m wip", "worker-shell")).toBe(true);
      expect(gates("git push origin main", "worker-shell")).toBe(true);
      expect(gates("git checkout -b feature", "worker-shell")).toBe(true);
      expect(gates("git", "worker-shell")).toBe(true);
    });

    it("gates mutating commands", () => {
      expect(gates("rm -rf /workspace", "worker-shell")).toBe(true);
      expect(gates("mv /workspace/a /workspace/b", "worker-shell")).toBe(true);
      expect(gates("mkdir -p /workspace/deep/dir", "worker-shell")).toBe(true);
      expect(gates("chmod 777 /workspace/hello.txt", "worker-shell")).toBe(true);
      expect(gates("npm install", "worker-shell")).toBe(true);
    });

    it("gates redirection, even of a read", () => {
      expect(gates("cat /workspace/a > /workspace/b", "worker-shell")).toBe(true);
      expect(gates("cat /workspace/a >> /workspace/b", "worker-shell")).toBe(true);
      expect(gates("cat < /workspace/a", "worker-shell")).toBe(true);
    });

    it("waves through a pipeline whose every stage is a read", () => {
      // A pipe moves bytes between processes and touches no files, so
      // a pipeline of reads is a read. Each stage is classified on its
      // own rather than the composition being waved through.
      expect(gates("ls -1 /workspace | wc -l", "worker-shell")).toBe(false);
      expect(gates("cat /workspace/a | grep needle", "worker-shell")).toBe(false);
      expect(gates("cat /workspace/a | grep needle | wc -l", "worker-shell")).toBe(false);
      expect(gates("ls /workspace || true", "worker-shell")).toBe(false);
      expect(gates("ls /workspace && cat /workspace/a", "worker-shell")).toBe(false);
      expect(gates("cd /workspace; ls", "worker-shell")).toBe(true);
    });

    it("gates a pipeline with a stage that is not a read", () => {
      expect(gates("ls /workspace; rm -rf /workspace", "worker-shell")).toBe(true);
      expect(gates("ls /workspace && rm -rf /workspace", "worker-shell")).toBe(true);
      expect(gates("cat /workspace/a | tee /workspace/b", "worker-shell")).toBe(true);
      expect(gates("find /workspace -type f | xargs rm", "worker-shell")).toBe(true);
      expect(gates("ls /workspace | sed -i s/a/b/", "worker-shell")).toBe(true);
    });

    it("names the offending stage when it gates a pipeline", () => {
      expect(
        decideApproval({ command: "ls /workspace | tee /workspace/b", backend: "worker-shell" })
          .reason,
      ).toContain("tee");
    });

    it("gates an empty or dangling stage", () => {
      expect(gates("ls /workspace |", "worker-shell")).toBe(true);
      expect(gates("| wc -l", "worker-shell")).toBe(true);
      expect(gates("ls &&", "worker-shell")).toBe(true);
    });

    it("still gates backgrounding, which leaves something running", () => {
      expect(gates("ls /workspace &", "worker-shell")).toBe(true);
      expect(gates("cat /workspace/a & cat /workspace/b", "worker-shell")).toBe(true);
    });

    it("still gates redirection inside a pipeline", () => {
      expect(gates("ls /workspace | wc -l > /workspace/count", "worker-shell")).toBe(true);
    });

    it("waves through echo and printf, which cannot write without a redirect", () => {
      // Both write to stdout only. Sending that to a file needs `>`,
      // which gates the whole line regardless of the verb.
      expect(gates("echo hello", "worker-shell")).toBe(false);
      expect(gates("ls /workspace && echo done", "worker-shell")).toBe(false);
      expect(gates("echo hello > /workspace/x", "worker-shell")).toBe(true);
    });

    it("gates command substitution", () => {
      expect(gates("cat $(ls /workspace)", "worker-shell")).toBe(true);
      expect(gates("cat `ls /workspace`", "worker-shell")).toBe(true);
      expect(gates("cat /workspace/$(whoami)", "worker-shell")).toBe(true);
    });

    it("gates a newline that hides a second command", () => {
      expect(gates("ls /workspace\nrm -rf /workspace", "worker-shell")).toBe(true);
    });

    it("gates a read verb handed a flag that writes", () => {
      // A verb allowlist is not enough on its own: several read
      // commands write when given the right flag, so an unrecognized
      // flag on a read verb has to gate too.
      expect(gates("find /workspace -mindepth 1 -delete", "worker-shell")).toBe(true);
      expect(gates("find /workspace -name x -exec rm {} +", "worker-shell")).toBe(true);
      expect(gates("find /workspace -execdir rm {} +", "worker-shell")).toBe(true);
      expect(gates("find /workspace -fprint /workspace/out", "worker-shell")).toBe(true);
      expect(gates("sort -o /workspace/out /workspace/in", "worker-shell")).toBe(true);
      expect(gates("sort --output=/workspace/out /workspace/in", "worker-shell")).toBe(true);
    });

    it("still waves through the read flags those verbs are used with", () => {
      expect(gates("find /workspace -name '*.ts'", "worker-shell")).toBe(false);
      expect(gates("find /workspace -type f -maxdepth 2", "worker-shell")).toBe(false);
      expect(gates("find /workspace -mtime -1", "worker-shell")).toBe(false);
      expect(gates("sort -n /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("sort -u -r /workspace/hello.txt", "worker-shell")).toBe(false);
    });

    it("gates an unrecognized flag on a checked verb", () => {
      expect(gates("find /workspace -frobnicate", "worker-shell")).toBe(true);
    });

    it("gates verbs whose writing cannot be told from their arguments", () => {
      // sed writes through -i and through a `w` command inside the
      // script, which a matcher cannot reliably find. uniq and tree
      // take an output file as a positional argument, and date -s sets
      // the clock. None of them are worth the false confidence, so
      // none of them are recognized reads.
      expect(gates("sed s/a/b/ /workspace/hello.txt", "worker-shell")).toBe(true);
      expect(gates("sed -i s/a/b/ /workspace/hello.txt", "worker-shell")).toBe(true);
      expect(gates("sed 'w /workspace/out' /workspace/hello.txt", "worker-shell")).toBe(true);
      expect(gates("uniq /workspace/in /workspace/out", "worker-shell")).toBe(true);
      expect(gates("tree -o /workspace/out", "worker-shell")).toBe(true);
      expect(gates("date -s 12:00", "worker-shell")).toBe(true);
    });

    it("strips leading environment assignments before reading the verb", () => {
      expect(gates("LC_ALL=C sort /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("LC_ALL=C rm /workspace/hello.txt", "worker-shell")).toBe(true);
    });

    it("reads the verb out of an absolute path", () => {
      expect(gates("/bin/cat /workspace/hello.txt", "worker-shell")).toBe(false);
      expect(gates("/bin/rm /workspace/hello.txt", "worker-shell")).toBe(true);
    });

    it("gates an unrecognized command rather than guessing", () => {
      expect(gates("frobnicate --hard", "worker-shell")).toBe(true);
      expect(gates("", "worker-shell")).toBe(true);
      expect(gates("   ", "worker-shell")).toBe(true);
    });
  });

  describe("the decision itself", () => {
    it("explains every gate it raises", () => {
      const commands: Array<[string, string]> = [
        ["rm -rf /workspace", "worker-shell"],
        ["cat /workspace/a > /workspace/b", "worker-shell"],
        ["uname -a", "container-shell"],
        ["export default async () => 2 + 2;", "worker-javascript"],
        ["frobnicate", "not-a-backend"],
      ];
      for (const [command, backend] of commands) {
        const decision = decideApproval({ command, backend });
        expect(decision.needsApproval).toBe(true);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });

    it("explains why it let a command through", () => {
      const decision = decideApproval({
        command: "cat /workspace/hello.txt",
        backend: "worker-shell",
      });
      expect(decision.needsApproval).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
    });

    it("names the backend rule in the reason, so the queue is readable", () => {
      expect(decideApproval({ command: "uname -a", backend: "container-shell" }).reason).toContain(
        "container-shell",
      );
    });

    it("is a pure function of command and backend", () => {
      // Approval survives a pause: the AI SDK re-runs the policy when
      // the turn resumes, and an approved call whose policy has since
      // flipped is converted to a denial. Same input, same answer,
      // every time.
      const call = { command: "find /workspace -delete", backend: "worker-shell" };
      const first = decideApproval(call);
      for (let i = 0; i < 5; i++) {
        expect(decideApproval(call)).toEqual(first);
      }
    });
  });

  describe("DEFAULT_APPROVAL_POLICY", () => {
    it("runs the matcher on just-bash alone and gates the rest outright", () => {
      expect(DEFAULT_APPROVAL_POLICY.rules).toEqual({
        "worker-shell": "read-only",
        "worker-javascript": "always",
        "container-shell": "always",
      });
      expect(DEFAULT_APPROVAL_POLICY.fallback).toBe("always");
    });

    it("names every backend the workspace registers", () => {
      // A backend missing from the table falls back to "always", which
      // is safe but silently costs a human every command. Pinning the
      // ids here means adding a backend to src/index.ts without
      // deciding its rule fails a test rather than degrading quietly.
      expect(Object.keys(DEFAULT_APPROVAL_POLICY.rules).sort()).toEqual([
        "container-shell",
        "worker-javascript",
        "worker-shell",
      ]);
    });
  });
});
