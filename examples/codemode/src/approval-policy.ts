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
 * Shell characters that disqualify a line outright, whatever it runs.
 *
 * Redirection writes files, and substitution and subshells run
 * commands this matcher would have to parse to see. None of them are
 * decomposable the way a pipeline is, so their presence ends the
 * question before the verb is considered.
 *
 * Backgrounding is here for a different reason: `ls &` leaves a
 * process alive past the command, which is not something to wave
 * through on the strength of the verb.
 */
const SHELL_METACHARACTERS: Array<[string, string]> = [
  [">", "redirects output"],
  ["<", "redirects input"],
  ["$", "expands a variable or substitutes a command"],
  ["`", "substitutes a command"],
  ["(", "groups or substitutes a command"],
  [")", "groups or substitutes a command"],
  ["\n", "hides a second command on another line"],
  ["\r", "hides a second command on another line"],
];

/**
 * Operators that join commands without touching the filesystem
 * themselves. A line built from these is split on them and every stage
 * classified on its own, so `ls | wc -l` reads and
 * `ls; rm -rf /` does not.
 *
 * Longest first, so `&&` and `||` are found before a bare `&` or `|`.
 */
const COMMAND_SEPARATORS = ["&&", "||", ";", "|"];

/**
 * Commands that only read.
 *
 * Deliberately conservative, and the omissions are the interesting
 * part. `awk` can write through its own syntax rather than through a
 * shell redirect. `sed` writes through `-i` and also
 * through a `w` command buried in its script, which no matcher is
 * going to find reliably. `uniq` and `tree` take an output file as a
 * positional argument, so their writes do not look like flags at all.
 * `date -s` sets the system clock. A verb whose writes cannot be read
 * off its arguments does not belong here, because listing it would
 * buy false confidence rather than fewer approvals.
 */
const READ_ONLY_COMMANDS = new Set([
  "basename",
  "cat",
  "cmp",
  "cut",
  "df",
  "diff",
  "dirname",
  "du",
  // echo and printf write to stdout and nowhere else. Sending that at
  // a file takes a redirect, which gates the line whatever the verb.
  "echo",
  "printf",
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
  "sort",
  "stat",
  "tail",
  "test",
  "true",
  "uname",
  "wc",
  "which",
  "whoami",
]);

/**
 * Flags a read verb is allowed to carry, for the verbs that write when
 * given the wrong one.
 *
 * A verb allowlist alone is not enough: `find` deletes with `-delete`
 * and runs arbitrary commands with `-exec`, and `sort` writes to a
 * file with `-o`. So for these verbs the flags are allowlisted too,
 * and an unrecognized flag gates. That is the same shape as the
 * `state.*` check — name what is allowed, treat everything else as a
 * question — rather than a blocklist that has to keep up with every
 * flag that happens to write.
 *
 * A verb absent from this table takes flags freely, which is only safe
 * because the verbs in READ_ONLY_COMMANDS that are absent here have no
 * flag that writes at all.
 */
const READ_ONLY_FLAGS: Record<string, Set<string>> = {
  find: new Set([
    "-a",
    "-and",
    "-atime",
    "-depth",
    "-empty",
    "-follow",
    "-group",
    "-ilname",
    "-iname",
    "-inum",
    "-ipath",
    "-iregex",
    "-links",
    "-lname",
    "-ls",
    "-maxdepth",
    "-mindepth",
    "-mmin",
    "-mtime",
    "-name",
    "-newer",
    "-not",
    "-o",
    "-or",
    "-path",
    "-perm",
    "-print",
    "-print0",
    "-printf",
    "-prune",
    "-readable",
    "-regex",
    "-samefile",
    "-size",
    "-type",
    "-user",
    "-xdev",
    "-H",
    "-L",
    "-P",
  ]),
  sort: new Set([
    "-b",
    "-c",
    "-d",
    "-f",
    "-g",
    "-h",
    "-i",
    "-k",
    "-M",
    "-n",
    "-r",
    "-s",
    "-t",
    "-u",
    "-V",
    "-z",
    "--check",
    "--ignore-case",
    "--key",
    "--numeric-sort",
    "--reverse",
    "--sort",
    "--unique",
    "--version-sort",
  ]),
};

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
 * Classify a shell line.
 *
 * Redirection and substitution disqualify the line outright. What is
 * left is a pipeline, which is split on its separators and judged one
 * stage at a time: the line reads only if every stage does. Piping and
 * sequencing touch no files themselves, so `ls | wc -l` is as much a
 * read as `ls` is, while the stage-by-stage check is what still catches
 * the `rm -rf` in `ls; rm -rf /`.
 */
function classifyShellLine(command: string): Verdict {
  for (const [character, effect] of SHELL_METACHARACTERS) {
    if (command.includes(character)) {
      const shown = character === "\n" || character === "\r" ? "a newline" : `"${character}"`;
      return { readOnly: false, reason: `${shown} ${effect}` };
    }
  }

  // A lone `&` backgrounds; a doubled one is the and-then separator
  // handled below.
  if (/(?<!&)&(?!&)/.test(command)) {
    return { readOnly: false, reason: '"&" backgrounds a command' };
  }

  const separator = new RegExp(
    `\\s*(?:${COMMAND_SEPARATORS.map((token) => token.replace(/[|]/g, "\\$&")).join("|")})\\s*`,
  );
  const stages = command.trim().split(separator);

  const verdicts: Verdict[] = [];
  for (const stage of stages) {
    if (stage.trim().length === 0) {
      return { readOnly: false, reason: "a stage of the pipeline is empty" };
    }
    const verdict = classifyShellCommand(stage);
    if (!verdict.readOnly) return verdict;
    verdicts.push(verdict);
  }

  if (verdicts.length === 1) return verdicts[0];
  return {
    readOnly: true,
    reason: `every stage only reads (${verdicts.map((verdict) => verdict.reason).join("; ")})`,
  };
}

/** Classify a single command, with no separators left in it. */
function classifyShellCommand(command: string): Verdict {
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

  const allowedFlags = READ_ONLY_FLAGS[verb];
  if (allowedFlags != null) {
    for (const arg of args) {
      if (!arg.startsWith("-")) continue;
      // A negative number is a value, not a flag: `find -mtime -1`.
      if (/^-\d/.test(arg)) continue;
      // Compare on the name so `--output=path` is caught as --output.
      const flag = arg.split("=")[0];
      if (!allowedFlags.has(flag)) {
        return {
          readOnly: false,
          reason: `"${flag}" is not a recognized read-only flag for "${verb}"`,
        };
      }
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
