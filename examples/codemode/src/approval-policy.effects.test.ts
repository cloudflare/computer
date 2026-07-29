/**
 * Does a command the policy waves through actually only read?
 *
 * `approval-policy.test.ts` pins what the matcher *says*: given this
 * command, does it ask for a human. Those assertions are worth having,
 * but they cannot find the failure that matters here, because the same
 * person writes the matcher and its tests and so shares a blind spot
 * with it. Both real defects in this policy were found by running the
 * agent by hand and noticing — `find /workspace -mindepth 1 -delete`
 * ran unattended because the verb was allowlisted and its flags were
 * not, and a pipeline of two reads asked for approval it did not need.
 * Neither was going to fall out of a list of examples somebody thought
 * to write down.
 *
 * So this file checks the claim against the world instead. It runs the
 * command for real and watches the filesystem:
 *
 *     the policy allows a command unattended  ⇒  running it writes nothing
 *
 * One direction only. A command the policy *gates* needs no check here,
 * because being asked about a read is a nuisance and not a breach; the
 * gated direction is already covered by the assertions next door.
 *
 * The corpus is generated rather than curated — every allowlisted verb
 * crossed with argument shapes that include the flags known to turn a
 * read into a write. Most combinations are nonsense (`pwd -delete`),
 * and that is fine: a nonsense command the matcher allows must still
 * not write. Deriving the verbs from READ_ONLY_COMMANDS rather than
 * from a copy means a verb added to the policy later comes under test
 * without anybody remembering to add it here.
 *
 * ## What this covers, and what it does not
 *
 * The shell is real: `just-bash`, the same implementation the `shell`
 * backend runs inside its Dynamic Worker, driven against just-bash's
 * own in-memory filesystem wrapped in a recorder. Whether `find
 * -delete` reaches for a delete is a fact about just-bash and holds
 * wherever its files happen to live, so the storage underneath does
 * not need to be the real Durable Object for the answer to be right.
 *
 * Two gaps, neither of them quiet:
 *
 * The `container` backend runs GNU coreutils rather than just-bash, so
 * the same command can behave differently there. The default policy
 * gates that backend outright, which is why the difference does not
 * bite — and is a reason to keep gating it.
 *
 * The `codemode` dialect is not exercised. Its claim is about a closed
 * list of `state.*` method names, which is a much smaller surface to
 * get wrong than the verb-and-flag combinatorics here, and reaching a
 * live `state` namespace would mean pulling the workspace package and
 * its workerd-only imports into this runner.
 */

import { Bash, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";

import { decideApproval, READ_ONLY_COMMANDS } from "./approval-policy.js";

/**
 * Every method on just-bash's filesystem interface that changes
 * something. Named explicitly rather than inferred, so a new mutating
 * method in a future just-bash shows up as an unrecorded write here
 * instead of being silently classified as a read.
 */
const MUTATORS = new Set([
  "appendFile",
  "chmod",
  "cp",
  "link",
  "mkdir",
  "mv",
  "rm",
  "symlink",
  "utimes",
  "writeFile",
]);

interface Run {
  writes: string[];
  exitCode: number;
  stderr: string;
}

/** Run one command against a fresh tree, recording every mutation. */
async function run(command: string): Promise<Run> {
  const inner = new InMemoryFs({
    "/workspace/a.txt": "beta\nalpha\n",
    "/workspace/b.txt": "gamma\n",
    "/workspace/sub/c.txt": "nested\n",
  });
  const writes: string[] = [];
  const recorder = new Proxy(inner, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function" || typeof key !== "string") return value;
      if (!MUTATORS.has(key)) return value.bind(target);
      return (...args: unknown[]) => {
        const shown = args.filter((arg) => typeof arg === "string").join(", ");
        writes.push(`${key}(${shown})`);
        return value.apply(target, args);
      };
    },
  });

  const bash = new Bash({ fs: recorder as never, cwd: "/workspace" });
  const result = await bash.exec(command);
  return { writes, exitCode: result.exitCode, stderr: result.stderr };
}

/**
 * Argument shapes to cross with every verb. The first few are ordinary
 * usage, present so the corpus contains commands that actually run;
 * the rest are the ways a read verb turns into a write — the flag that
 * deletes, the flag that names an output file, the flag that edits in
 * place, the operator that hands the output to something else.
 */
const ARGUMENT_SHAPES = [
  "",
  "/workspace",
  "/workspace/a.txt",
  "-1 /workspace",
  "-l /workspace",
  "/workspace/a.txt /workspace/b.txt",
  "-delete /workspace",
  "/workspace -delete",
  "/workspace -mindepth 1 -delete",
  "/workspace -type f -delete",
  "-i s/alpha/beta/ /workspace/a.txt",
  "--in-place /workspace/a.txt",
  "-o /workspace/out /workspace/a.txt",
  "--output=/workspace/out /workspace/a.txt",
  "-w /workspace/out /workspace/a.txt",
  "-s /workspace/a.txt",
  "/workspace/a.txt > /workspace/out",
  "/workspace/a.txt >> /workspace/a.txt",
  "/workspace | tee /workspace/out",
  "/workspace/a.txt | sed -i s/a/b/ /workspace/b.txt",
];

/** Whole-line shapes, to cover composition rather than one verb. */
const COMPOSED = [
  "ls -1 /workspace | wc -l",
  "cat /workspace/a.txt | grep alpha",
  "cat /workspace/a.txt | sort | head -1",
  "ls /workspace && cat /workspace/a.txt",
  "ls /workspace || true",
  "ls /workspace; rm -rf /workspace",
  "find /workspace -type f | xargs rm",
  "find /workspace -type f | tee /workspace/out",
  "cat /workspace/a.txt > /workspace/out",
  "sort /workspace/a.txt -o /workspace/a.txt",
  "grep -r alpha /workspace | cut -d: -f1",
  "test -f /workspace/a.txt && echo yes",
  "echo hello",
  "printf '%s\\n' hello",
  "pwd",
  "ls -la /workspace/sub",
];

function corpus(): string[] {
  const commands = new Set<string>(COMPOSED);
  for (const verb of READ_ONLY_COMMANDS) {
    for (const shape of ARGUMENT_SHAPES) {
      commands.add(shape.length === 0 ? verb : `${verb} ${shape}`);
    }
  }
  // git is handled by its own branch in the matcher, on a subcommand
  // rather than a flag, so it needs its own shapes.
  for (const sub of [
    "log",
    "status",
    "diff",
    "show",
    "add -A",
    "commit -m x",
    "checkout .",
    "clean -fd",
  ]) {
    commands.add(`git ${sub}`);
    commands.add(`git ${sub} > /workspace/out`);
  }
  return [...commands];
}

describe("the detector itself", () => {
  // If these fail, every other assertion in this file is worthless:
  // a recorder that sees nothing makes any command look like a read.
  it("sees a write", async () => {
    const { writes } = await run("printf hi > /workspace/new.txt");
    expect(writes).toContain("writeFile(/workspace/new.txt, hi, utf8)");
  });

  it("sees a delete, including one reached through find", async () => {
    const { writes } = await run("find /workspace -mindepth 1 -delete");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.startsWith("rm("))).toBe(true);
  });

  it("stays quiet on a read", async () => {
    expect((await run("cat /workspace/a.txt")).writes).toEqual([]);
    expect((await run("ls -1 /workspace | wc -l")).writes).toEqual([]);
  });

  it("would catch a policy that waved a write through", async () => {
    // The policy is the thing under test, so prove the harness fails
    // when the policy is wrong. `never` is the rule that trusts a
    // backend completely; under it, a destructive command is
    // "allowed", and the property below must not hold.
    const policy = { rules: { shell: "never" as const } };
    const command = "rm -rf /workspace/sub";
    expect(decideApproval({ command, backend: "shell" }, policy).needsApproval).toBe(false);
    expect((await run(command)).writes.length).toBeGreaterThan(0);
  });
});

describe("every command the policy allows unattended", () => {
  it("writes nothing", async () => {
    const violations: string[] = [];
    let allowed = 0;
    let ran = 0;

    for (const command of corpus()) {
      if (decideApproval({ command, backend: "shell" }).needsApproval) continue;
      allowed += 1;
      const result = await run(command);
      if (result.exitCode === 0) ran += 1;
      if (result.writes.length > 0) {
        violations.push(`${JSON.stringify(command)} → ${result.writes.join(", ")}`);
      }
    }

    // Reported together rather than one at a time: the useful output
    // is the whole set of holes, not whichever one sorts first.
    expect(violations, `the policy allowed ${violations.length} command(s) that wrote`).toEqual([]);

    // A corpus that gates everything, or a shell that cannot run
    // anything, would satisfy the assertion above while checking
    // nothing at all.
    //
    // These floors exist to catch a harness that died, not a policy
    // that tightened, so they sit well under what passes today: 630
    // commands generated, 475 allowed, 163 of those exiting 0. A
    // policy that legitimately narrows should not have to come here
    // and edit numbers; a just-bash that stopped running commands, or
    // a corpus that stopped generating them, lands near zero.
    expect(allowed, "commands the policy allowed unattended").toBeGreaterThan(100);
    expect(ran, "allowed commands that also exited 0").toBeGreaterThan(40);
  });
});
