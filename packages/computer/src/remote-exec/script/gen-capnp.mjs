#!/usr/bin/env node
// Regenerates src/remote-exec/capnp/exec.ts from remote-exec's schema with capnp-es, which runs
// the `capnp` compiler (install Cap'n Proto first), and formats it. The output is committed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const schema = resolve(pkg, "../remote-exec/schema");
const out = resolve(pkg, "src/remote-exec/capnp/exec.ts");
execFileSync(
  "npx",
  ["capnp-es", `${schema}/exec.capnp`, `--src-prefix=${schema}`, `-ots:${dirname(out)}`],
  { stdio: "inherit", cwd: pkg },
);
const [first, ...rest] = readFileSync(out, "utf8").split("\n");
writeFileSync(
  out,
  [
    first,
    "// @ts-nocheck -- generated code doesn't follow this package's compiler options.",
    ...rest,
  ].join("\n"),
);
execFileSync("npx", ["oxfmt", out], { stdio: "inherit", cwd: pkg });
