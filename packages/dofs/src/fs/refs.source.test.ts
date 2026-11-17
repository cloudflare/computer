import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Every statement that drops a reference to a chunk blob or a manifest
// has to go through fs/refs.ts, which is where unreferenced content is
// reaped, and only refs.ts and gc() delete content rows. A write that
// drops a reference anywhere else leaks the old content; a delete
// anywhere else can remove content something still references. This
// test reads the source of every package in the repository and fails
// on any such statement outside the allowed files, so a new write path
// can't get either wrong without someone noticing.
//
// It reads files from disk, so it runs only under node; the workers
// config excludes it.

const PACKAGES = fileURLToPath(new URL("../../..", import.meta.url));

interface Statement {
  name: string;
  // Returns true when `code` contains the statement.
  find: (code: string) => boolean;
}

function pattern(name: string, regex: RegExp): Statement {
  return { name, find: (code) => regex.test(code) };
}

// The text after each match of `start`, up to the first match of `end`
// or `limit` characters, whichever comes first. Used to look inside one
// SQL statement without caring how its string literals are split.
function regionsAfter(code: string, start: RegExp, end: RegExp, limit = 600): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(new RegExp(start.source, "gi"))) {
    const from = (match.index ?? 0) + match[0].length;
    const rest = code.slice(from, from + limit);
    const stop = rest.search(end);
    out.push(stop === -1 ? rest : rest.slice(0, stop));
  }
  return out;
}

const STATEMENTS: Statement[] = [
  pattern("DELETE FROM vfs_chunks", /DELETE\s+FROM\s+vfs_chunks\b/i),
  pattern("REPLACE INTO vfs_chunks", /REPLACE\s+INTO\s+vfs_chunks\b/i),
  pattern("INSERT INTO vfs_chunks", /INSERT\s+INTO\s+vfs_chunks\b/i),
  pattern("UPDATE vfs_chunks", /UPDATE\s+vfs_chunks\b/i),
  pattern("DELETE FROM vfs_nodes", /DELETE\s+FROM\s+vfs_nodes\b/i),
  pattern("REPLACE INTO vfs_nodes", /REPLACE\s+INTO\s+vfs_nodes\b/i),
  {
    // Any UPDATE of vfs_nodes whose SET clause names manifest_hash,
    // however the statement's string literals are put together.
    name: "manifest_hash write",
    find: (code) =>
      regionsAfter(code, /UPDATE\s+vfs_nodes\b/, /\bWHERE\b/i).some((set) =>
        /\bmanifest_hash\b/i.test(set),
      ) ||
      regionsAfter(code, /INSERT\s+INTO\s+vfs_nodes\b/, /;/).some((insert) =>
        /\bDO\s+UPDATE\b[\s\S]*\bmanifest_hash\b/i.test(insert),
      ),
  },
  pattern("DELETE FROM vfs_blobs", /DELETE\s+FROM\s+vfs_blobs\b/i),
  pattern("DELETE FROM vfs_blob_bytes", /DELETE\s+FROM\s+vfs_blob_bytes\b/i),
  pattern("DELETE FROM vfs_manifests", /DELETE\s+FROM\s+vfs_manifests\b/i),
];

// fs/refs.ts owns the statements. gc() deletes content rows nothing
// references. The v4 -> v5 migration rebuilds vfs_chunks by copying
// every row across, which moves references without dropping any.
const ALLOWED: Record<string, string[]> = {
  "dofs/src/fs/refs.ts": STATEMENTS.map((s) => s.name),
  "dofs/src/fs/gc.ts": ["DELETE FROM vfs_blobs", "DELETE FROM vfs_manifests"],
  "dofs/src/schema/migrations.ts": ["INSERT INTO vfs_chunks"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "bench" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|mts|js|mjs)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
    out.push(path);
  }
  return out;
}

// Every packages/*/src file, as "<package>/src/<path>", with comments
// taken out so prose that mentions a statement does not count.
function packageSources(): Array<{ rel: string; code: string }> {
  const out: Array<{ rel: string; code: string }> = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, "src");
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
      out.push({ rel: relative(PACKAGES, file).split("\\").join("/"), code });
    }
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const { rel, code } of packageSources()) {
    for (const statement of STATEMENTS) {
      if (ALLOWED[rel]?.includes(statement.name)) continue;
      if (statement.find(code)) found.push(`${rel}: ${statement.name}`);
    }
  }
  return found;
}

// Staging bytes or reporting them present promises them to a link or
// a peer that comes after an await. An unreferenced blob can be reaped
// in between unless the caller pins it, defers reaps, or can live with
// a failed block, so every call is counted here with how it copes. A
// new call in a listed file fails the test just like one in a new file.
const STAGING_CALL = /(?<![\w.])(stageBlob|hasObjects)\(/g;
const STAGING_CALLERS: Record<string, { calls: number; why: string }> = {
  "dofs/src/sync/blobs.ts": { calls: 1, why: "defines stageBlob" },
  "dofs/src/sync/fetch.ts": {
    calls: 1,
    why: "defines hasObjects, which pins what it reports present",
  },
  "dofs/src/fs/writeFile.ts": {
    calls: 1,
    why: "streaming writeFile pins each staged window until it links",
  },
  "dofs/src/sync/apply.ts": {
    calls: 1,
    why: "applyFileEntry stages and links inside one entry's reap deferral",
  },
  // A blob lost between staging and the link fails the block, and the
  // next push or pull plans it again with a fresh probe.
  "rpc/src/interface.ts": { calls: 1, why: "declares the peer method" },
  "rpc/src/server.ts": {
    calls: 4,
    why: "push receiver stages, then a later push links; hasObjects passthrough",
  },
  "rpc/src/sync-engine.ts": { calls: 3, why: "pull probes and stages before applyChanges" },
  "rpc/src/sync-driver.ts": { calls: 2, why: "pull probes and stages before applyChanges" },
};

function stagingCalls(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { rel, code } of packageSources()) {
    const calls = [...code.matchAll(STAGING_CALL)].length;
    if (calls > 0) counts[rel] = calls;
  }
  return counts;
}

describe("reference choke points", () => {
  it("recognizes every statement shape it guards", () => {
    const samples: Record<string, string> = {
      "DELETE FROM vfs_chunks": `db.run("DELETE FROM vfs_chunks WHERE inode = ?")`,
      "REPLACE INTO vfs_chunks": `"INSERT OR REPLACE INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)"`,
      "INSERT INTO vfs_chunks": `"INSERT INTO vfs_chunks (inode, idx, hash, size) VALUES (?, ?, ?, ?)"`,
      "UPDATE vfs_chunks": `"UPDATE vfs_chunks SET hash = ? WHERE inode = ?"`,
      "DELETE FROM vfs_nodes": `"DELETE FROM vfs_nodes WHERE inode = ?"`,
      "REPLACE INTO vfs_nodes": `"REPLACE INTO vfs_nodes (inode, type) VALUES (?, 'file')"`,
      "manifest_hash write": `db.run("UPDATE vfs_nodes SET mode = ?, " + "manifest_hash = NULL " + "WHERE inode = ?")`,
      "DELETE FROM vfs_blobs": `"DELETE FROM vfs_blobs WHERE hash = ?"`,
      "DELETE FROM vfs_blob_bytes": `"DELETE FROM vfs_blob_bytes WHERE hash = ?"`,
      "DELETE FROM vfs_manifests": `"DELETE FROM vfs_manifests WHERE hash = ?"`,
    };
    for (const statement of STATEMENTS) {
      expect(statement.find(samples[statement.name] ?? ""), statement.name).toBe(true);
    }
    const manifestWrite = STATEMENTS.find((s) => s.name === "manifest_hash write");
    // An upsert that rewrites manifest_hash on conflict is a write.
    expect(
      manifestWrite?.find(
        "INSERT INTO vfs_nodes (inode, manifest_hash) VALUES (?, ?) ON CONFLICT(inode) DO UPDATE SET manifest_hash = excluded.manifest_hash;",
      ),
    ).toBe(true);
    // Reads that compare manifest_hash, and updates of other columns,
    // are not.
    expect(manifestWrite?.find(`"SELECT 1 FROM vfs_nodes n WHERE n.manifest_hash = ?"`)).toBe(
      false,
    );
    expect(
      manifestWrite?.find(
        `"UPDATE vfs_nodes SET mount_root = ? WHERE inode = ?"; // manifest_hash`,
      ),
    ).toBe(false);
  });

  it("keeps every statement that drops a reference or deletes content in fs/refs.ts", () => {
    expect(offenders()).toEqual([]);
  });

  it("counts every call that stages blobs or reports them present", () => {
    expect([..."stageBlob(db, hash, bytes)".matchAll(STAGING_CALL)]).toHaveLength(1);
    expect([..."await remote.hasObjects(hashes)".matchAll(STAGING_CALL)]).toHaveLength(0);
    const expected = Object.fromEntries(
      Object.entries(STAGING_CALLERS).map(([rel, { calls }]) => [rel, calls]),
    );
    expect(stagingCalls()).toEqual(expected);
  });
});
