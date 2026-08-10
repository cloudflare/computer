import { describe, expect, it, vi } from "vitest";

import { grep } from "./grep.js";
import { mkdir } from "./mkdir.js";
import { withDB } from "./with-db.js";
import { CHUNK_SIZE, writeFile } from "./writeFile.js";

describe("grep", () => {
  it("returns no matches for an empty file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/empty", "", {}, () => 0);
      expect(await grep(db, "TODO", "/empty")).toEqual([]);
    });
  });

  it("finds a single match in a single file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "line one\nTODO fix me\nline three\n", {}, () => 0);
      expect(await grep(db, "TODO", "/a.txt")).toEqual([
        { path: "/a.txt", line: 2, text: "TODO fix me" },
      ]);
    });
  });

  it("returns multiple matches in one file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "a TODO here\nplain\nb TODO there\n", {}, () => 0);
      expect(await grep(db, "TODO", "/a.txt")).toEqual([
        { path: "/a.txt", line: 1, text: "a TODO here" },
        { path: "/a.txt", line: 3, text: "b TODO there" },
      ]);
    });
  });

  it("walks a directory recursively", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d/sub", { recursive: true }, () => 0);
      await writeFile(db, "/d/a.txt", "TODO root\n", {}, () => 0);
      await writeFile(db, "/d/sub/b.txt", "TODO nested\n", {}, () => 0);
      await writeFile(db, "/d/sub/c.txt", "no match\n", {}, () => 0);
      const matches = await grep(db, "TODO", "/d");
      expect(matches.map((m) => m.path).sort()).toEqual(["/d/a.txt", "/d/sub/b.txt"]);
    });
  });

  it("respects the ignoreCase option", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "todo\nTODO\nTodo\n", {}, () => 0);
      expect((await grep(db, "TODO", "/a.txt", { ignoreCase: true })).length).toBe(3);
      expect((await grep(db, "TODO", "/a.txt", { ignoreCase: false })).length).toBe(1);
      expect((await grep(db, "TODO", "/a.txt")).length).toBe(1);
    });
  });

  it("supports opt-in regular expressions and literal strings by default", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "task 12\ntask \\d+\ntask xx\n", {}, () => 0);
      expect(
        (await grep(db, String.raw`task \d+`, "/a.txt", { regex: true })).map(
          (match) => match.line,
        ),
      ).toEqual([1]);
      expect((await grep(db, String.raw`task \d+`, "/a.txt")).map((match) => match.line)).toEqual([
        2,
      ]);
      await expect(grep(db, "[", "/a.txt", { regex: true })).rejects.toThrow(
        "Invalid regular expression",
      );
    });
  });

  it("returns numbered context around matches", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "one\ntwo\nTODO\nfour\nfive\n", {}, () => 0);
      expect(await grep(db, "TODO", "/a.txt", { context: 1 })).toEqual([
        {
          path: "/a.txt",
          line: 3,
          text: "TODO",
          context: [
            { line: 2, text: "two", isMatch: false },
            { line: 3, text: "TODO", isMatch: true },
            { line: 4, text: "four", isMatch: false },
          ],
        },
      ]);
    });
  });

  it("marks adjacent matches as matching context", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "TODO one\nTODO two\nplain\n", {}, () => 0);

      const matches = await grep(db, "TODO", "/a.txt", { context: 1 });
      expect(matches).toEqual([
        {
          path: "/a.txt",
          line: 1,
          text: "TODO one",
          context: [
            { line: 1, text: "TODO one", isMatch: true },
            { line: 2, text: "TODO two", isMatch: true },
          ],
        },
        {
          path: "/a.txt",
          line: 2,
          text: "TODO two",
          context: [
            { line: 1, text: "TODO one", isMatch: true },
            { line: 2, text: "TODO two", isMatch: true },
            { line: 3, text: "plain", isMatch: false },
          ],
        },
      ]);

      if (matches[0].context === undefined || matches[1].context === undefined) {
        throw new Error("expected grep context");
      }
      matches[0].context[0].text = "changed";
      expect(matches[1].context[0].text).toBe("TODO one");
    });
  });

  it("applies offset and limit across files in path and line order", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "TODO a1\nTODO a2\n", {}, () => 0);
      await writeFile(db, "/b.txt", "TODO b1\nTODO b2\n", {}, () => 0);
      expect(
        (await grep(db, "TODO", "/", { offset: 1, limit: 2 })).map(
          (match) => `${match.path}:${match.line}`,
        ),
      ).toEqual(["/a.txt:2", "/b.txt:1"]);
    });
  });

  it("filters directory searches by an include glob before applying pagination", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.md", "TODO markdown\n", {}, () => 0);
      await writeFile(db, "/b.ts", "TODO one\nTODO two\n", {}, () => 0);
      await writeFile(db, "/c.ts", "TODO three\n", {}, () => 0);

      expect(
        (await grep(db, "TODO", "/", { include: "**/*.ts", offset: 1, limit: 2 })).map(
          (match) => `${match.path}:${match.line}`,
        ),
      ).toEqual(["/b.ts:2", "/c.ts:1"]);
    });
  });

  it("walks each directory page once during a search", async () => {
    await withDB(async (db) => {
      for (let index = 0; index < 260; index += 1) {
        await writeFile(db, `/file-${String(index).padStart(3, "0")}.txt`, "plain\n", {}, () => 0);
      }
      const all = vi.spyOn(db, "all");

      expect(await grep(db, "missing", "/", { include: "*.txt", limit: 1 })).toEqual([]);

      const childPageQueries = all.mock.calls.filter(([query]) =>
        String(query).includes("d.name > ?"),
      );
      expect(childPageQueries.length).toBeGreaterThan(1);
      expect(childPageQueries.filter(([, , afterName]) => afterName === "")).toHaveLength(1);
    });
  });

  it("matches across a chunk boundary", async () => {
    await withDB(async (db) => {
      // Lay out a file whose line straddles the 512KiB chunk boundary.
      const pad = "a".repeat(CHUNK_SIZE - 5);
      const content = `${pad}TODO straddle\nafter\n`;
      await writeFile(db, "/big.txt", content, {}, () => 0);
      const matches = await grep(db, "TODO", "/big.txt");
      expect(matches).toHaveLength(1);
      expect(matches[0].path).toBe("/big.txt");
      expect(matches[0].text.endsWith("TODO straddle")).toBe(true);
    });
  });

  it("returns lines 1-indexed", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "first\nsecond\nthird\n", {}, () => 0);
      expect(await grep(db, "first", "/a.txt")).toEqual([
        { path: "/a.txt", line: 1, text: "first" },
      ]);
      expect(await grep(db, "third", "/a.txt")).toEqual([
        { path: "/a.txt", line: 3, text: "third" },
      ]);
    });
  });

  it("rejects ENOENT when the path is missing", async () => {
    await withDB(async (db) => {
      await expect(grep(db, "x", "/missing")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
