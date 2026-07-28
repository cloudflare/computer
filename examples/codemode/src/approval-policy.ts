/**
 * Which commands a human has to approve before the agent runs them.
 *
 * The policy is a table keyed by backend id, because the three
 * backends differ in what they can reach: `container` is a full Linux
 * userland with a public network, while `shell` and `codemode` are
 * sandboxed and see only the workspace filesystem. Expressing the
 * rules per backend keeps the interesting decision visible and
 * configurable instead of buried in a list of blocked commands.
 *
 * Every rule denies by default. Under `read-only`, a command runs
 * unattended only when it is *recognizably* a read; anything the
 * matcher does not understand needs a human. That direction matters:
 * a matcher that fails closed turns an unparsed command into a
 * question, while one that fails open turns it into an unreviewed
 * mutation.
 *
 * It is worth being plain about the limit here. Pattern-matching a
 * command line is a heuristic, appropriate for an example. A
 * production gate belongs at the capability layer — hand the backend
 * a read-only view of the workspace and let the filesystem refuse the
 * write — rather than in a matcher that has to anticipate every way a
 * shell can be told to write a file. Denying by default is what makes
 * the heuristic's failure mode tolerable in the meantime.
 *
 * `decideApproval` must stay a pure function of the command and the
 * backend. The AI SDK re-runs it when a paused turn resumes, and an
 * approved call whose policy has since flipped to "no approval
 * needed" is converted into a denial. Consulting a clock, or any
 * mutable state, would make approvals decay on their own.
 */

/** What a backend's commands cost in human attention. */
export type BackendRule =
  /** Every command on this backend needs a human. */
  | "always"
  /** Recognized reads run unattended; everything else needs a human. */
  | "read-only"
  /** Nothing on this backend needs a human. */
  | "never";

/**
 * The language a backend's `command` field is written in. The
 * `read-only` rule has to parse the command to classify it, and the
 * codemode backend takes JavaScript where the others take a shell
 * line.
 */
export type CommandDialect = "shell" | "javascript";

export interface ApprovalPolicy {
  /** Rule per backend id, matching the ids the Workspace registered. */
  rules: Record<string, BackendRule>;
  /**
   * Rule for a backend absent from `rules`. Defaults to `always`, so
   * registering a new backend cannot quietly widen what runs
   * unattended.
   */
  fallback?: BackendRule;
  /**
   * Command language per backend. Defaults to JavaScript for the
   * codemode backend and a shell line for everything else.
   */
  dialects?: Record<string, CommandDialect>;
}

export interface ApprovalDecision {
  needsApproval: boolean;
  /**
   * One line explaining the verdict, shown to whoever works the
   * approval queue. Populated for allowed commands too, so a
   * transcript can say why nothing was asked.
   */
  reason: string;
}

/**
 * The example's policy. The container backend is gated outright: it
 * runs real binaries with public network access, so "which command is
 * it" is the wrong question to be asking. The two sandboxed backends
 * can reach only the workspace filesystem, so reads there are cheap
 * enough to run unattended.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  rules: { shell: "read-only", codemode: "read-only", container: "always" },
  fallback: "always",
};

const DEFAULT_DIALECTS: Record<string, CommandDialect> = {
  shell: "shell",
  container: "shell",
  codemode: "javascript",
};

/**
 * Shell characters that redirect output or glue a second command onto
 * the first. Their presence disqualifies a line on its own, before
 * the verb is even considered: `cat a > b` writes, and
 * `ls; rm -rf /` is not the `ls` it appears to be. A pipeline of two
 * reads is harmless in principle, but allowing composition means
 * classifying every element and every operator, so the gate stays
 * closed on all of it.
 */
const SHELL_METACHARACTERS: Array<[string, string]> = [
  [">", "redirects output"],
  ["<", "redirects input"],
  ["|", "pipes into another command"],
  [";", "chains another command"],
  ["&", "chains or backgrounds another command"],
  ["$", "expands a variable or substitutes a command"],
  ["`", "substitutes a command"],
  ["(", "groups or substitutes a command"],
  [")", "groups or substitutes a command"],
  ["\n", "hides a second command on another line"],
  ["\r", "hides a second command on another line"],
];

/**
 * Commands that only read. Deliberately conservative: `echo` and
 * `awk` are absent because both can write through their own syntax
 * rather than through a shell redirect, and the extra approvals cost
 * less than the argument about whether the matcher caught every form.
 */
const READ_ONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cmp",
  "cut",
  "date",
  "df",
  "diff",
  "dirname",
  "du",
  "egrep",
  "fgrep",
  "file",
  "find",
  "grep",
  "head",
  "id",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "tree",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

/** Git subcommands that only inspect history. */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "log",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "show",
  "status",
]);

/** `state.*` calls that only read. The mutations are the complement. */
const READ_ONLY_STATE_MEMBERS = new Set([
  "exists",
  "find",
  "grep",
  "lstat",
  "ls",
  "readFile",
  "readFileBytes",
  "readdir",
  "readlink",
  "stat",
]);

export function decideApproval(
  call: { command: string; backend: string },
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
): ApprovalDecision {
  const rule = policy.rules[call.backend] ?? policy.fallback ?? "always";

  if (rule === "never") {
    return {
      needsApproval: false,
      reason: `the ${call.backend} backend is configured to run without approval`,
    };
  }

  if (rule === "always") {
    return {
      needsApproval: true,
      reason: `the ${call.backend} backend requires approval for every command`,
    };
  }

  const dialect = policy.dialects?.[call.backend] ?? DEFAULT_DIALECTS[call.backend] ?? "shell";
  const verdict =
    dialect === "javascript" ? classifyJavaScript(call.command) : classifyShellLine(call.command);

  return { needsApproval: !verdict.readOnly, reason: verdict.reason };
}

interface Verdict {
  readOnly: boolean;
  reason: string;
}

/**
 * Classify a shell line. Composition and redirection disqualify it
 * outright; otherwise the leading verb has to be a recognized read.
 */
function classifyShellLine(command: string): Verdict {
  for (const [character, effect] of SHELL_METACHARACTERS) {
    if (command.includes(character)) {
      const shown = character === "\n" || character === "\r" ? "a newline" : `"${character}"`;
      return { readOnly: false, reason: `${shown} ${effect}` };
    }
  }

  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  // `LC_ALL=C sort file` runs sort, so step over any leading
  // environment assignments to find the verb.
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
    index += 1;
  }
  const words = tokens.slice(index);
  if (words.length === 0) {
    return { readOnly: false, reason: "the command is empty" };
  }

  const path = words[0];
  const verb = path.slice(path.lastIndexOf("/") + 1);
  const args = words.slice(1);

  if (verb === "git") return classifyGit(args);

  if (!READ_ONLY_COMMANDS.has(verb)) {
    return { readOnly: false, reason: `"${verb}" is not a recognized read-only command` };
  }

  // sed is a filter until it is handed -i, at which point it rewrites
  // its input in place.
  if (verb === "sed") {
    const inPlace = args.find(
      (arg) =>
        arg === "--in-place" ||
        arg.startsWith("--in-place=") ||
        (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("i")),
    );
    if (inPlace != null) {
      return { readOnly: false, reason: `sed ${inPlace} edits the file in place` };
    }
  }

  return { readOnly: true, reason: `"${verb}" only reads` };
}

function classifyGit(args: string[]): Verdict {
  // The first bare word is the subcommand. A global flag that takes a
  // value (`git -C dir status`) shifts it, and the resulting mismatch
  // gates the command, which is the safe direction to be wrong in.
  const subcommand = args.find((arg) => !arg.startsWith("-"));
  if (subcommand == null) {
    return { readOnly: false, reason: "git without a subcommand" };
  }
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { readOnly: false, reason: `"git ${subcommand}" is not a recognized read-only command` };
  }
  return { readOnly: true, reason: `"git ${subcommand}" only reads` };
}

/**
 * Classify a codemode snippet by the `state.*` calls it names.
 *
 * This allowlists reads rather than blocklisting writes, which is what
 * lets it catch `state["writeFile"]`: every mention of `state` has to
 * resolve to a named member, and a computed access or an alias is
 * unclassifiable and therefore gated. A blocklist would wave the same
 * snippet through.
 */
function classifyJavaScript(command: string): Verdict {
  const mentions = [...command.matchAll(/\bstate\b/g)];
  if (mentions.length === 0) {
    // The codemode sandbox has no network and no other route into the
    // store, so a snippet that never names `state` can only compute.
    return { readOnly: true, reason: "the snippet does not reach the workspace" };
  }

  const members = new Set<string>();
  for (const mention of mentions) {
    const rest = command.slice((mention.index ?? 0) + mention[0].length);
    const access = /^\s*(?:\.|\?\.)\s*([A-Za-z_$][\w$]*)/.exec(rest);
    if (access == null) {
      return {
        readOnly: false,
        reason:
          "the snippet reaches state through a computed access or an alias, so its effect cannot be classified",
      };
    }
    members.add(access[1]);
  }

  for (const member of members) {
    if (!READ_ONLY_STATE_MEMBERS.has(member)) {
      return { readOnly: false, reason: `state.${member} is not a recognized read-only call` };
    }
  }

  const named = [...members].map((member) => `state.${member}`).join(", ");
  return { readOnly: true, reason: `the snippet only reads (${named})` };
}
