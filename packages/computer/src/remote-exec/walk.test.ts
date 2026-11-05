import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SyncFs } from "./fs";
import { TESTS_DIR } from "./testing/harness";
import { directoryFs } from "./testing/local";
import { linkStaysInside, normalizeGlobs, relativeCwd, Selector, walkWorkspace } from "./walk";

interface Fixture {
  description: string;
  files: Record<string, string>;
  symlinks?: Record<string, string>;
  exclude?: string;
  cases: { globs: string[]; expected: string[]; skipped?: string[] }[];
}

const FIXTURES = path.join(TESTS_DIR, "fixtures/ignore");
const fixtures = fs.readdirSync(FIXTURES).map((f) => ({
  name: f.replace(/\.json$/, ""),
  ...(JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")) as Fixture),
}));

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "remote-exec-walk-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function build(root: string, fixture: Fixture, git: boolean): Promise<void> {
  if (git) execFileSync("git", ["init", "-q", root]);
  for (const [rel, content] of Object.entries(fixture.files)) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), content);
  }
  for (const [rel, target] of Object.entries(fixture.symlinks ?? {})) {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.symlink(target, path.join(root, rel));
  }
  if (fixture.exclude !== undefined) {
    await fsp.mkdir(path.join(root, ".git/info"), { recursive: true });
    await fsp.writeFile(path.join(root, ".git/info/exclude"), fixture.exclude);
  }
}

describe("shared .gitignore fixtures (also run by packages/remote-exec/src/walk.rs)", () => {
  it("has enough cases to mean something", () => {
    expect(fixtures.reduce((n, f) => n + f.cases.length, 0)).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: ${fixture.description}`, async () => {
      await build(dir, fixture, false);
      for (const c of fixture.cases) {
        const walked = await walkWorkspace(directoryFs(dir), "/workspace", new Selector(c.globs));
        expect(
          walked.found.map((f) => f.rel),
          JSON.stringify(c.globs),
        ).toEqual(c.expected);
        expect(walked.skipped.map((s) => s.path).sort()).toEqual(c.skipped ?? []);
      }
    });

    // The fixtures' expectations are only as good as their author: check them against git, which
    // never lists its own .git directory.
    it(`${fixture.name}: expectations agree with git check-ignore`, async () => {
      await build(dir, fixture, true);
      const untracked = execFileSync(
        "git",
        // Without the user's own excludes file, which would add rules the fixtures don't have.
        ["-C", dir, "-c", "core.excludesFile=", "ls-files", "--others", "--exclude-standard", "-z"],
        { encoding: "utf8" },
      )
        .split("\0")
        .filter(Boolean);
      for (const c of fixture.cases) {
        const selector = new Selector(c.globs);
        const byGit = untracked
          .filter((rel) => selector.matches(rel))
          .filter((rel) => {
            const target = fixture.symlinks?.[rel];
            return target === undefined || linkStaysInside(rel, target);
          })
          .sort();
        const expected = c.expected.filter((rel) => !rel.startsWith(".git/"));
        expect(byGit, JSON.stringify(c.globs)).toEqual(expected);
      }
    });
  }
});

describe("walkWorkspace", () => {
  it("reports kinds, modes, sizes and link targets", async () => {
    await fsp.writeFile(path.join(dir, "run.sh"), "#!/bin/sh\n");
    await fsp.chmod(path.join(dir, "run.sh"), 0o755);
    await fsp.writeFile(path.join(dir, "data.txt"), "hello");
    await fsp.symlink("data.txt", path.join(dir, "link"));
    const walked = await walkWorkspace(directoryFs(dir), "/workspace", new Selector(["**"]));
    expect(walked.found).toEqual([
      { rel: "data.txt", kind: "file", mode: 0o644, size: 5, target: "" },
      { rel: "link", kind: "symlink", mode: 0o777, size: 0, target: "data.txt" },
      { rel: "run.sh", kind: "file", mode: 0o755, size: 10, target: "" },
    ]);
  });

  it("pages through large directories", async () => {
    for (let i = 0; i < 2500; i++)
      await fsp.writeFile(path.join(dir, `f${String(i).padStart(4, "0")}`), "");
    const walked = await walkWorkspace(directoryFs(dir), "/workspace", new Selector(["**"]));
    expect(walked.found).toHaveLength(2500);
  });

  it("treats a store without modes as ordinary files", async () => {
    await fsp.writeFile(path.join(dir, "a"), "x");
    const real = directoryFs(dir);
    const modeless: SyncFs = {
      ...real,
      lstat: async (p) => ({ ...(await real.lstat(p)), mode: 0 }),
    };
    expect((await walkWorkspace(modeless, "/workspace", new Selector(["**"]))).found[0]?.mode).toBe(
      0o644,
    );
  });

  it("prunes directories no glob can reach, without reading them", async () => {
    await fsp.mkdir(path.join(dir, "src"), { recursive: true });
    await fsp.mkdir(path.join(dir, "huge/deep"), { recursive: true });
    await fsp.writeFile(path.join(dir, "src/a.ts"), "");
    const real = directoryFs(dir);
    const read: string[] = [];
    const watching: SyncFs = {
      ...real,
      readdir: (p, o) => {
        read.push(p);
        return real.readdir(p, o);
      },
    };
    await walkWorkspace(watching, "/workspace", new Selector(["src/**"]));
    expect(read).toEqual(["/workspace", "/workspace/src"]);
  });

  it("returns nothing for an empty selection or a missing root", async () => {
    await fsp.writeFile(path.join(dir, "a"), "");
    expect((await walkWorkspace(directoryFs(dir), "/workspace", new Selector([]))).found).toEqual(
      [],
    );
    expect(
      (await walkWorkspace(directoryFs(dir), "/workspace/missing", new Selector(["**"]))).found,
    ).toEqual([]);
    expect(
      (await walkWorkspace(directoryFs(dir), "/workspace", new Selector(["!a"]))).found,
    ).toEqual([]);
  });
});

describe("normalizeGlobs", () => {
  it("makes globs relative to the root", () => {
    expect(
      normalizeGlobs(
        ["src/**", "./a.txt", "/workspace/b/**", "!/workspace/b/x", "!./c"],
        "/workspace",
      ),
    ).toEqual(["src/**", "a.txt", "b/**", "!b/x", "!c"]);
    expect(normalizeGlobs(undefined, "/workspace")).toEqual([]);
    expect(normalizeGlobs(["x"], "/workspace/")).toEqual(["x"]);
  });

  it("resolves relative globs against cwd, as the command's own paths are", () => {
    const globs = ["**", "!node_modules/**", "../shared/*.ts", "./src/**", "/workspace/top.txt"];
    const expected = ["app/**", "!app/node_modules/**", "shared/*.ts", "app/src/**", "top.txt"];
    expect(normalizeGlobs(globs, "/workspace", "/workspace/app")).toEqual(expected);
    expect(normalizeGlobs(globs, "/workspace", "/workspace/app/")).toEqual(expected);
    expect(normalizeGlobs(globs, "/workspace", "app")).toEqual(expected);
    expect(normalizeGlobs(["x/**"], "/workspace", "/workspace")).toEqual(["x/**"]);
    expect(normalizeGlobs(["x/**"], "/workspace", "a/b/..")).toEqual(["a/x/**"]);
  });

  it("refuses relative globs when cwd is outside the root, and globs that leave it from cwd", () => {
    expect(() => normalizeGlobs(["src/**"], "/workspace", "/tmp")).toThrow(/outside \/workspace/);
    expect(normalizeGlobs(["/workspace/src/**"], "/workspace", "/tmp")).toEqual(["src/**"]);
    for (const bad of ["../../x", "**/../../y", "*/../.."]) {
      expect(() => normalizeGlobs([bad], "/workspace", "/workspace/app"), bad).toThrow(TypeError);
    }
    expect(() => normalizeGlobs(["x"], "/workspace", "../elsewhere")).toThrow(TypeError);
  });

  it("refuses globs that leave the root", () => {
    for (const bad of [
      "/etc/**",
      "/workspace",
      "/workspacex/a",
      "../x",
      "a/../../b",
      "",
      "./",
      "!",
    ]) {
      expect(() => normalizeGlobs([bad], "/workspace"), bad).toThrow(TypeError);
    }
  });
});

describe("Selector", () => {
  it("matches dotfiles, braces, classes and negations like globset", () => {
    const s = new Selector(["src/**/*.{ts,tsx}", "!**/*.test.ts", ".env"]);
    expect(s.matches("src/a.ts")).toBe(true);
    expect(s.matches("src/x/.hidden.tsx")).toBe(true);
    expect(s.matches("src/a.test.ts")).toBe(false);
    expect(s.matches(".env")).toBe(true);
    expect(s.matches("src/a.js")).toBe(false);
    expect(new Selector(["*"]).matches("a/b")).toBe(false);
  });

  it("knows which directories can hold matches", () => {
    const s = new Selector(["app/src/**", "docs/*.md"]);
    for (const d of ["app", "app/src", "app/src/deep", "docs"]) expect(s.mayEnter(d), d).toBe(true);
    for (const d of ["node_modules", "application", "apps", "ap"])
      expect(s.mayEnter(d), d).toBe(false);
    expect(new Selector(["**/*.ts"]).mayEnter("any/where")).toBe(true);
  });
});

describe("linkStaysInside", () => {
  it("matches the Rust side", () => {
    expect(linkStaysInside("link", "target")).toBe(true);
    expect(linkStaysInside("a/link", "../b")).toBe(true);
    expect(linkStaysInside("a/link", "./b/../c")).toBe(true);
    expect(linkStaysInside("a/b/link", "x/../../../y")).toBe(true);
    expect(linkStaysInside("a/link", "../../b")).toBe(false);
    expect(linkStaysInside("a/b/link", "x/../../../../y")).toBe(false);
    expect(linkStaysInside("link", "/etc/passwd")).toBe(false);
  });
});

describe("trailing slashes", () => {
  it("are trimmed from cwd, the root and globs, quickly however many there are", () => {
    expect(relativeCwd("/workspace/app//", "/workspace/")).toBe("app");
    expect(relativeCwd("/workspace///", "/workspace")).toBe("");
    expect(normalizeGlobs(["/workspace/a/**"], "/workspace//")).toEqual(["a/**"]);
    const slashes = "/".repeat(200_000);
    const started = performance.now();
    expect(relativeCwd(`/workspace${slashes}x`, `/workspace${slashes}`)).toBe("x");
    expect(relativeCwd(`/workspace/app${slashes}`, "/workspace")).toBe("app");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
