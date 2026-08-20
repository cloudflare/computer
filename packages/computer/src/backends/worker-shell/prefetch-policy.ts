// Decides whether a shell command is worth opening a directory
// prefetch scope for, and over which root.
//
// The adapter can answer a whole subtree walk from one server-side
// find(), but loading that snapshot costs a call, so it only pays off
// for commands that would otherwise issue one readdir per directory:
// `find` and recursive `grep`.
//
// This is a heuristic over the raw command string, deliberately kept
// simple. Getting it wrong in the "don't prefetch" direction costs
// nothing but the status quo; getting it wrong in the "do prefetch"
// direction costs one extra call and, for mutating traversals, could
// serve a listing that the command itself has invalidated. So the
// rules below are conservative: recognise the clear cases, decline
// everything else.

function normalizePath(path: string): string {
  const parts = path.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join("/")}`;
}

function resolveAgainst(cwd: string, path: string): string {
  if (path.startsWith("/")) return normalizePath(path);
  return normalizePath(`${cwd}/${path}`);
}

// Longest common ancestor of two absolute paths.
function commonAncestor(a: string, b: string): string {
  if (a === b) return a;
  const left = a.split("/").filter(Boolean);
  const right = b.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) break;
    out.push(left[i]);
  }
  return `/${out.join("/")}`;
}

// Split a command line into pipeline/list segments so a traversal
// anywhere in the line is found. Quoting is not interpreted; a
// separator inside quotes only ever splits a segment into two, which
// at worst makes us decline to prefetch.
function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

// Tokenise on whitespace, stripping one layer of surrounding quotes.
function tokenize(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = re.exec(segment);
  while (match !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
    match = re.exec(segment);
  }
  return out;
}

// find expressions that change the tree as they walk. A snapshot taken
// before the walk would describe entries the command then removes, so
// decline rather than risk serving a stale listing.
const FIND_MUTATING = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

function findRoot(tokens: string[], cwd: string): string | undefined {
  for (const token of tokens) {
    if (FIND_MUTATING.has(token)) return undefined;
  }
  // Start paths are the operands before the first expression token.
  const starts: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-") || token === "(" || token === ")" || token === "!") break;
    starts.push(token);
  }
  if (starts.length === 0) return cwd;
  let root = resolveAgainst(cwd, starts[0]);
  for (const start of starts.slice(1)) root = commonAncestor(root, resolveAgainst(cwd, start));
  return root;
}

function grepRoot(tokens: string[], cwd: string): string | undefined {
  let recursive = false;
  const operands: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      operands.push(...tokens.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) continue;
    if (token.startsWith("-") && token.length > 1) {
      if (/[rR]/.test(token.slice(1))) recursive = true;
      continue;
    }
    operands.push(token);
  }
  if (!recursive) return undefined;
  // operands[0] is the pattern; the rest are search roots.
  const paths = operands.slice(1);
  if (paths.length === 0) return cwd;
  let root = resolveAgainst(cwd, paths[0]);
  for (const path of paths.slice(1)) root = commonAncestor(root, resolveAgainst(cwd, path));
  return root;
}

/**
 * The directory to prefetch for `command`, or undefined when the
 * command would not benefit. When several traversals appear in one
 * line the shallowest common ancestor is returned so a single scope
 * covers them all.
 */
export function prefetchRootFor(command: string, cwd: string): string | undefined {
  let root: string | undefined;
  for (const segment of segments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const name = tokens[0];
    let candidate: string | undefined;
    if (name === "find") candidate = findRoot(tokens, cwd);
    else if (name === "grep") candidate = grepRoot(tokens, cwd);
    if (candidate === undefined) continue;
    root = root === undefined ? candidate : commonAncestor(root, candidate);
  }
  return root;
}
