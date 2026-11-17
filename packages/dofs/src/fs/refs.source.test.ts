import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Every statement that drops a reference to a chunk blob or a manifest
// has to go through fs/refs.ts, which is where unreferenced content is
// reclaimed. A write that drops a reference anywhere else leaks the old
// content. This test reads the package source and fails on any such
// statement outside the allowed files, so a new write path can't leak
// without someone noticing.
//
// It reads files from disk, so it runs only under node; the workers
// config excludes it.

const SRC = fileURLToPath(new URL("..", import.meta.url));

// Statements that drop or replace a reference. The manifest pattern
// stops at a quote so it stays inside one SQL string.
const DROPPING_STATEMENTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "DELETE FROM vfs_chunks", pattern: /DELETE\s+FROM\s+vfs_chunks\b/i },
  { name: "REPLACE INTO vfs_chunks", pattern: /REPLACE\s+INTO\s+vfs_chunks\b/i },
  { name: "INSERT INTO vfs_chunks", pattern: /INSERT\s+INTO\s+vfs_chunks\b/i },
  { name: "UPDATE vfs_chunks", pattern: /UPDATE\s+vfs_chunks\b/i },
  { name: "DELETE FROM vfs_nodes", pattern: /DELETE\s+FROM\s+vfs_nodes\b/i },
  {
    name: "manifest_hash write",
    pattern: /UPDATE\s+vfs_nodes\s+SET\b[^"'`]*\bmanifest_hash\s*=/i,
  },
];

// fs/refs.ts owns the statements. The v4 -> v5 migration rebuilds
// vfs_chunks by copying every row across, which moves references
// without dropping any.
const ALLOWED: Record<string, string[]> = {
  "fs/refs.ts": DROPPING_STATEMENTS.map((s) => s.name),
  "schema/migrations.ts": ["INSERT INTO vfs_chunks"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "bench") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    const text = readFileSync(file, "utf8");
    for (const { name, pattern } of DROPPING_STATEMENTS) {
      if (ALLOWED[rel]?.includes(name)) continue;
      if (pattern.test(text)) found.push(`${rel}: ${name}`);
    }
  }
  return found;
}

describe("reference choke points", () => {
  it("recognizes every statement shape it guards", () => {
    const samples = [
      "DELETE FROM vfs_chunks WHERE inode = ?",
      "INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      "INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)",
      "UPDATE vfs_chunks SET hash = ? WHERE inode = ?",
      "DELETE FROM vfs_nodes WHERE inode = ?",
      "UPDATE vfs_nodes SET mode = ?, manifest_hash = NULL WHERE inode = ?",
    ];
    for (const { name, pattern } of DROPPING_STATEMENTS) {
      expect(
        samples.some((sample) => pattern.test(sample)),
        name,
      ).toBe(true);
    }
    // A read that compares manifest_hash is not a write.
    const manifestWrite = DROPPING_STATEMENTS.find((s) => s.name === "manifest_hash write");
    expect(manifestWrite?.pattern.test("SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = ?")).toBe(
      false,
    );
  });

  it("keeps every statement that drops a chunk or manifest reference in fs/refs.ts", () => {
    expect(offenders()).toEqual([]);
  });
});
