import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { decodeFiles, encodeFiles, type OutgoingFile } from "@cloudflare/computer-rpc/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTransfer, type PullPlan } from "./transfer.js";

const encoder = new TextEncoder();

let root: string;
let transfer: FileTransfer;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "computerd-files-"));
  transfer = new FileTransfer(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function outgoing(
  filePath: string,
  text: string,
  mtime = 1_700_000_000_000,
  mode = 0o644,
  rev?: number,
) {
  const bytes = encoder.encode(text);
  return {
    header: {
      path: filePath,
      size: bytes.length,
      mtime,
      mode,
      ...(rev === undefined ? {} : { rev }),
    },
    body: async () => bytes,
  } satisfies OutgoingFile;
}

async function write(relative: string, text: string, mtime?: number): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, text);
  if (mtime !== undefined) await fs.utimes(absolute, mtime / 1000, mtime / 1000);
}

async function received(plan: PullPlan) {
  if (plan.stream === undefined) {
    throw new Error(`expected files, got conflicts ${JSON.stringify(plan.conflicts)}`);
  }
  const out: Record<string, string> = {};
  for await (const file of decodeFiles(plan.stream)) {
    out[file.header.path] = await new Response(file.body).text();
  }
  return out;
}

describe("FileTransfer.receive", () => {
  it("writes files with their mode and mtime, creating directories", async () => {
    const result = await transfer.receive(
      encodeFiles([
        outgoing("a.txt", "hello"),
        outgoing("deep/dir/run.sh", "#!/bin/sh", 1_600_000_000_000, 0o755),
      ]),
    );
    expect(result).toEqual({ written: 2, bytes: 14 });
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("hello");
    const script = await fs.stat(path.join(root, "deep/dir/run.sh"));
    expect(script.mode & 0o777).toBe(0o755);
    expect(Math.floor(script.mtimeMs)).toBe(1_600_000_000_000);
  });

  it("replaces an existing file and leaves no temporary files behind", async () => {
    await write("a.txt", "old contents");
    await transfer.receive(encodeFiles([outgoing("a.txt", "new")]));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("new");
    expect(await fs.readdir(root)).toEqual(["a.txt"]);
  });

  it("fails on a truncated transfer without leaving a partial file", async () => {
    const full = new Uint8Array(
      await new Response(encodeFiles([outgoing("big.bin", "x".repeat(1000))])).arrayBuffer(),
    );
    const cut = new Response(full.slice(0, 500)).body as ReadableStream<Uint8Array>;
    await expect(transfer.receive(cut)).rejects.toThrow(/ended early/);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("FileTransfer.diff", () => {
  it("wants missing files and files whose size or mtime differ", async () => {
    await transfer.receive(
      encodeFiles([outgoing("same.txt", "same"), outgoing("touched.txt", "same")]),
    );
    const want = await transfer.diff([
      { path: "same.txt", size: 4, mtime: 1_700_000_000_000 },
      { path: "touched.txt", size: 4, mtime: 1_700_000_000_999 },
      { path: "resized.txt", size: 5, mtime: 1_700_000_000_000 },
      { path: "missing/file.txt", size: 1, mtime: 0 },
    ]);
    expect(want).toEqual(["touched.txt", "resized.txt", "missing/file.txt"]);
  });

  it("refuses paths that would escape the root", async () => {
    await expect(transfer.diff([{ path: "../etc/passwd", size: 0, mtime: 0 }])).rejects.toThrow(
      /Invalid transfer path/,
    );
  });
});

describe("FileTransfer.list and send", () => {
  beforeEach(async () => {
    await write("package.json", "{}");
    await write("src/index.js", "index");
    await write("src/lib/util.js", "util");
    await write("src/readme.md", "readme");
    await write("dist/out.js", "out");
    await write("dist/assets/logo.svg", "<svg/>");
    await write("node_modules/dep/index.js", "dep");
    await fs.symlink(path.join(root, "package.json"), path.join(root, "link.json"));
  });

  it("matches globs and literal directories, skipping symbolic links", async () => {
    const js = await transfer.list(["**/*.js"]);
    expect(js.map((file) => file.path)).toEqual([
      "dist/out.js",
      "node_modules/dep/index.js",
      "src/index.js",
      "src/lib/util.js",
    ]);
    const dist = await transfer.list(["./dist", "package.json", "*.json"]);
    expect(dist.map((file) => file.path)).toEqual([
      "dist/assets/logo.svg",
      "dist/out.js",
      "package.json",
    ]);
  });

  it("prunes excluded directories at any depth", async () => {
    const js = await transfer.list(["**/*.js"], ["node_modules", "**/lib"]);
    expect(js.map((file) => file.path)).toEqual(["dist/out.js", "src/index.js"]);
  });

  it("returns nothing for a pattern whose directory does not exist", async () => {
    expect(await transfer.list(["missing/**"])).toEqual([]);
  });

  it("sends matching files, leaving out what the caller already has", async () => {
    await write("dist/out.js", "out", 1_000_000);
    expect(await received(await transfer.send({ patterns: ["dist"] }))).toEqual({
      "dist/assets/logo.svg": "<svg/>",
      "dist/out.js": "out",
    });
    const files = await transfer.list(["dist"]);
    const logo = files.find((file) => file.path === "dist/assets/logo.svg");
    const again = await transfer.send({
      patterns: ["dist"],
      have: [
        // Held, same size, written after the container's copy: skipped.
        { path: "dist/out.js", size: 3, mtime: 2_000_000 },
        // Held, but the container's copy is newer: sent.
        { path: "dist/assets/logo.svg", size: 6, mtime: (logo?.mtime ?? 0) - 1 },
      ],
    });
    expect(await received(again)).toEqual({ "dist/assets/logo.svg": "<svg/>" });
  });
});

describe("FileTransfer rooted at /", () => {
  it("takes paths relative to the container root", async () => {
    const atRoot = new FileTransfer("/");
    const relative = root.slice(1);
    await atRoot.receive(encodeFiles([outgoing(`${relative}/src/a.txt`, "a")]));
    expect(await fs.readFile(path.join(root, "src/a.txt"), "utf8")).toBe("a");
    const listed = await atRoot.list([`/${relative}/src`]);
    expect(listed.map((file) => file.path)).toEqual([`${relative}/src/a.txt`]);
  });

  it("never walks into /proc, /sys or /dev", async () => {
    const atRoot = new FileTransfer("/");
    expect(await atRoot.list(["proc/self/status", "proc/**", "dev/**", "sys/**"])).toEqual([]);
  });
});

describe("FileTransfer manifest", () => {
  const T = 1_700_000_000_000;

  it("records a pushed file at its revision, with the hash of its bytes", async () => {
    await transfer.receive(encodeFiles([outgoing("a.txt", "hello", T, 0o644, 7)]));
    expect(transfer.recorded("a.txt")).toEqual({
      rev: 7,
      // sha256("hello")
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      size: 5,
      mtime: T,
    });
    // A push without a revision leaves nothing recorded.
    await transfer.receive(encodeFiles([outgoing("a.txt", "hello", T)]));
    expect(transfer.recorded("a.txt")).toBeUndefined();
  });

  it("diffs by revision when the file is recorded, keeping container changes", async () => {
    await transfer.receive(encodeFiles([outgoing("a.txt", "one", T, 0o644, 3)]));
    // Same revision: held, even though the mtime the host sends differs.
    expect(await transfer.diff([{ path: "a.txt", size: 3, mtime: T + 5, rev: 3 }])).toEqual([]);
    // The container edited it; the Workspace did not. Nothing to push.
    await write("a.txt", "container edit");
    expect(await transfer.diff([{ path: "a.txt", size: 3, mtime: T, rev: 3 }])).toEqual([]);
    // The Workspace moved on: wanted.
    expect(await transfer.diff([{ path: "a.txt", size: 3, mtime: T, rev: 4 }])).toEqual(["a.txt"]);
  });

  it("skips a recorded file the container left alone, whatever the Workspace did", async () => {
    await transfer.receive(encodeFiles([outgoing("a.txt", "one", T, 0o644, 3)]));
    const plan = await transfer.send({
      patterns: ["a.txt"],
      have: [{ path: "a.txt", size: 9, mtime: T + 1000, rev: 10 }],
    });
    expect(await received(plan)).toEqual({});
  });

  it("treats a touch with identical bytes as no change", async () => {
    await transfer.receive(encodeFiles([outgoing("a.txt", "one", T, 0o644, 3)]));
    await fs.utimes(path.join(root, "a.txt"), (T + 60_000) / 1000, (T + 60_000) / 1000);
    const plan = await transfer.send({
      patterns: ["a.txt"],
      have: [{ path: "a.txt", size: 3, mtime: T, rev: 10 }],
    });
    expect(await received(plan)).toEqual({});
    expect(transfer.recorded("a.txt")?.mtime).toBe(T + 60_000);
  });

  it("sends a file only the container changed", async () => {
    await transfer.receive(encodeFiles([outgoing("a.txt", "one", T, 0o644, 3)]));
    await write("a.txt", "built");
    const plan = await transfer.send({
      patterns: ["a.txt"],
      have: [{ path: "a.txt", size: 3, mtime: T, rev: 3 }],
    });
    expect(await received(plan)).toEqual({ "a.txt": "built" });
  });

  it("refuses a pull of a file both sides changed, sending nothing, unless forced", async () => {
    await transfer.receive(
      encodeFiles([outgoing("a.txt", "one", T, 0o644, 3), outgoing("b.txt", "b", T, 0o644, 4)]),
    );
    await write("a.txt", "container edit");
    await write("b.txt", "container edit");
    const have = [
      { path: "a.txt", size: 3, mtime: T + 1, rev: 9 },
      // The Workspace did not move on for b: no conflict on its own.
      { path: "b.txt", size: 1, mtime: T, rev: 4 },
    ];
    const plan = await transfer.send({ patterns: ["*.txt"], have });
    expect(plan.stream).toBeUndefined();
    expect(plan.conflicts).toEqual([
      { path: "a.txt", reason: "modified", localRev: 9, baseRev: 3 },
    ]);

    const forced = await transfer.send({ patterns: ["*.txt"], have, force: true });
    expect(await received(forced)).toEqual({
      "a.txt": "container edit",
      "b.txt": "container edit",
    });
  });

  it("calls an unrecorded file that looks changed on both sides untracked", async () => {
    await write("new.txt", "container", T + 10_000);
    await write("old.txt", "same", T);
    const plan = await transfer.send({
      patterns: ["*.txt"],
      have: [
        { path: "new.txt", size: 9, mtime: T, rev: 5 },
        // Same size and the Workspace copy is newer: taken as the same file.
        { path: "old.txt", size: 4, mtime: T + 1, rev: 6 },
      ],
    });
    expect(plan.conflicts).toEqual([{ path: "new.txt", reason: "untracked", localRev: 5 }]);
  });

  it("records a pulled file only once the host reports its revision", async () => {
    await write("dist/out.js", "out", T);
    expect(await received(await transfer.send({ patterns: ["dist"] }))).toEqual({
      "dist/out.js": "out",
    });
    expect(transfer.recorded("dist/out.js")).toBeUndefined();

    expect(
      transfer.record([
        { path: "dist/out.js", rev: 12 },
        // Never sent: ignored.
        { path: "dist/other.js", rev: 13 },
      ]),
    ).toBe(1);
    expect(transfer.recorded("dist/out.js")).toMatchObject({ rev: 12, size: 3, mtime: T });

    // The Workspace edited its copy after the pull; the container did not
    // touch its own. Not a conflict, and nothing to send.
    const again = await transfer.send({
      patterns: ["dist"],
      have: [{ path: "dist/out.js", size: 5, mtime: T + 5, rev: 20 }],
    });
    expect(await received(again)).toEqual({});

    // Now the container rebuilds it too: conflict.
    await write("dist/out.js", "rebuilt", T + 10);
    const conflict = await transfer.send({
      patterns: ["dist"],
      have: [{ path: "dist/out.js", size: 5, mtime: T + 5, rev: 20 }],
    });
    expect(conflict.conflicts).toEqual([
      { path: "dist/out.js", reason: "modified", localRev: 20, baseRev: 12 },
    ]);
  });
});
