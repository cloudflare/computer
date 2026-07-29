// Shell command templating with automatic escaping.
//
// `Workspace.shell.exec` takes a single command string that the
// container runs through `/bin/sh -c`. Building that string by hand
// is a shell-injection footgun: any interpolated path, branch name,
// or user-supplied value can break out of its argument and run
// arbitrary commands. Every example in this repo grew its own
// `shellQuote` helper to dodge that, which is duplicated, easy to
// forget, and noisy at the call site.
//
// `sh` is a tagged template that escapes interpolated values for
// you, so
//
//   sh`cat ${file}`
//
// quotes `file` no matter what it contains. The literal parts of the
// template are emitted verbatim — they're the trusted command — and
// only the `${...}` substitutions are escaped. The static parts come
// from `strings.raw`, so a backslash you write in the template (for
// a `sed` script, say) reaches the shell as you wrote it rather than
// as a processed escape sequence.
//
// Interpolation rules:
//   - strings and numbers are quoted with `shellQuote`;
//   - arrays are quoted element-by-element and joined with spaces, so
//     `sh`rm ${files}`` expands to a safe argument list;
//   - a `{ raw: "..." }` value is spliced in verbatim, for the rare
//     case where you genuinely mean shell syntax (a pipe, a redirect,
//     a pre-quoted sub-command). This mirrors Bun's shell API.

// A value `sh` splices in without escaping. The escape hatch from
// auto-escaping: use it only for values you control and know are
// shell-safe.
export interface RawShellValue {
  raw: string;
}

// A value `sh` knows how to interpolate. Strings and numbers are
// quoted; arrays are quoted per-element; `{ raw: "..." }` passes
// through untouched.
export type ShellValue = string | number | RawShellValue | ReadonlyArray<string | number>;

function isRaw(value: ShellValue): value is RawShellValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "raw" in value;
}

// Quote a single argument for `/bin/sh -c`. Values made up only of
// characters that the shell never treats specially are returned as-is
// for readability; everything else is wrapped in single quotes with
// embedded single quotes escaped as `'\''`.
export function shellQuote(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_\-+=:,./@%]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function interpolate(value: ShellValue): string {
  if (isRaw(value)) return value.raw;
  if (Array.isArray(value)) {
    return (value as ReadonlyArray<string | number>)
      .map((item) => shellQuote(String(item)))
      .join(" ");
  }
  return shellQuote(String(value));
}

// Guard against `exec` being called as a tagged template. `exec`
// takes a plain command string, and over Workers RPC that string is
// all that crosses the wire — a `TemplateStringsArray`'s `.raw`
// property is dropped by structured clone, so escaping can't happen
// on the far side. Escaping has to run caller-side through `sh`,
// which collapses to a string before the call.
//
// A command is never legitimately an array, so reject any array.
// That catches both the local `exec`cat ${x}`` mistake (the array
// still carries `.raw`) and the same call made through a worker-side
// stub, where structured clone has already stripped `.raw` but the
// indexed array shape survives. Either way the unsafe path fails
// loudly and points at the fix.
export function assertNotTemplate(command: unknown): asserts command is string {
  if (Array.isArray(command)) {
    throw new TypeError(
      "The remote stub's exec() does not take a tagged template. Reach the " +
        "Workspace through getWorkspace(stub) and call exec as a template there, " +
        "or wrap the command in the sh tag so interpolated values are escaped " +
        "before the command crosses the RPC boundary.",
    );
  }
}

// Tagged template that builds a shell command string with every
// interpolated value escaped. The static template parts come from
// `strings.raw` — they're trusted and emitted verbatim, backslashes
// and all — and only `${...}` substitutions are escaped. See the file
// header for the interpolation rules.
export function sh(strings: TemplateStringsArray, ...values: ShellValue[]): string {
  const parts = strings.raw;
  let out = parts[0];
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]) + parts[i + 1];
  }
  return out;
}
