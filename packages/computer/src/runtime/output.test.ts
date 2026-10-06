import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import { describe, expect, it } from "vitest";

import { Workspace } from "../workspace.js";
import type { WorkspaceOutputOptions } from "./output-files.js";
import { type CommandOutputFiles, OutputSpool } from "./output-spool.js";
import { DEFAULT_OUTPUT_MAX_BYTES, takeTail } from "./output-tail.js";
import type {
  WorkspaceModuleBackend,
  WorkspaceModuleBackendHandle,
  WorkspaceRuntimeEvent,
} from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lines(count: number, from = 1): string {
  let text = "";
  for (let line = from; line < from + count; line += 1) text += `line ${line}\n`;
  return text;
}

// A module backend whose every run prints the configured chunks to
// stdout, then exits 0. Each run gets its own id.
function printingBackend(chunks: () => Uint8Array[], id = "printer"): WorkspaceModuleBackend {
  let runs = 0;
  const handle: WorkspaceModuleBackendHandle = {
    async exec(input) {
      runs += 1;
      const id = input.id ?? `run-${runs}`;
      return { id, events: eventsFor(id, chunks()) };
    },
    async getExec(input) {
      return { id: input.id, events: eventsFor(input.id, chunks()) };
    },
    async killExec() {},
    async disposeExec() {},
  };
  return { protocol: "module", id, type: "test", connect: async () => handle };
}

function eventsFor(id: string, chunks: Uint8Array[]): ReadableStream<WorkspaceRuntimeEvent> {
  let seq = 0;
  return new ReadableStream({
    start(controller) {
      for (const value of chunks) controller.enqueue({ id, seq: ++seq, name: "stdout", value });
      controller.enqueue({ id, seq: ++seq, name: "exit", code: 0 });
      controller.close();
    },
  });
}

function workspaceWith(chunks: () => Uint8Array[], output?: WorkspaceOutputOptions | false) {
  return new Workspace({
    storage: new SQLiteTestStorage(),
    backends: [printingBackend(chunks)],
    ...(output === undefined ? {} : { output }),
  });
}

describe("takeTail", () => {
  const limits = { maxLines: 3, maxBytes: 1024 };

  it("keeps the last lines up to maxLines", () => {
    const tail = takeTail(encoder.encode("a\nb\nc\nd\ne\n"), 5, limits);
    expect(decoder.decode(tail.bytes)).toBe("c\nd\ne\n");
    expect(tail).toMatchObject({ firstLine: 3, lastLine: 5, partialLine: false });
  });

  it("counts text after the last newline as a line", () => {
    const tail = takeTail(encoder.encode("a\nb\nc\nd"), 4, limits);
    expect(decoder.decode(tail.bytes)).toBe("b\nc\nd");
    expect(tail.firstLine).toBe(2);
  });

  it("keeps whole lines within maxBytes", () => {
    const tail = takeTail(encoder.encode("1234\n5678\nab\n"), 3, { maxLines: 10, maxBytes: 7 });
    expect(decoder.decode(tail.bytes)).toBe("ab\n");
    expect(tail).toMatchObject({ firstLine: 3, partialLine: false });
  });

  it("keeps the end of a last line longer than maxBytes", () => {
    const tail = takeTail(encoder.encode("x\nabcdefghij"), 2, { maxLines: 10, maxBytes: 4 });
    expect(decoder.decode(tail.bytes)).toBe("ghij");
    expect(tail).toMatchObject({ firstLine: 2, lastLine: 2, partialLine: true });
  });

  it("starts on a UTF-8 character boundary", () => {
    const tail = takeTail(encoder.encode("ééé"), 1, { maxLines: 10, maxBytes: 3 });
    expect(decoder.decode(tail.bytes)).toBe("é");
  });
});

describe("Workspace command output", () => {
  it("keeps output that fits the limits whole and saves nothing", async () => {
    const ws = workspaceWith(() => [encoder.encode(lines(10))]);
    const result = await (await ws.runtime.exec("print", { encoding: "utf8" })).result();
    expect(result.stdout).toBe(lines(10));
    expect(result.truncated).toBeUndefined();
    await expect(ws.fs.readdir("/.computer/output")).rejects.toThrow();
  });

  it("keeps the last 2000 lines and saves the full output", async () => {
    const full = lines(5000);
    const ws = workspaceWith(() => [encoder.encode(full)]);
    const result = await (await ws.runtime.exec("print", { encoding: "utf8" })).result();

    expect(result.stdout).toBe(lines(2000, 3001));
    expect(result.truncated?.stdout).toEqual({
      status: "saved",
      path: "/.computer/output/printer.run-1.stdout.log",
      totalBytes: encoder.encode(full).length,
      totalLines: 5000,
      firstLine: 3001,
      partialLine: false,
    });
    expect(result.truncated?.stderr).toBeUndefined();
    await expect(
      ws.fs.readFile("/.computer/output/printer.run-1.stdout.log", "utf8"),
    ).resolves.toBe(full);
  });

  it("keeps at most 50 KiB of long output that arrives in many chunks", async () => {
    const chunk = encoder.encode(`${"x".repeat(1023)}\n`.repeat(64));
    const ws = workspaceWith(() => Array.from({ length: 160 }, () => chunk));
    const result = await (await ws.runtime.exec("print")).result();

    expect(result.stdout.length).toBeLessThanOrEqual(DEFAULT_OUTPUT_MAX_BYTES);
    expect(result.stdout.length).toBe(50 * 1024);
    expect(result.truncated?.stdout).toMatchObject({
      status: "saved",
      totalBytes: 160 * chunk.length,
      totalLines: 160 * 64,
      firstLine: 160 * 64 - 49,
    });
    const saved = await ws.fs.stat("/.computer/output/printer.run-1.stdout.log");
    expect(saved.size).toBe(160 * chunk.length);
  });

  it("saves raw bytes exactly as the command printed them", async () => {
    const png = new Uint8Array(200 * 1024);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let index = 8; index < png.length; index += 1) png[index] = index % 251;
    const ws = workspaceWith(() => [png]);
    const result = await (await ws.runtime.exec("cat image.png")).result();

    expect(result.truncated?.stdout?.status).toBe("saved");
    const stream = await ws.fs.readFile("/.computer/output/printer.run-1.stdout.log");
    const saved = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(saved).toEqual(png);
  });

  it("tells a streaming caller where the output was saved on the exit event", async () => {
    const ws = workspaceWith(() => [encoder.encode(lines(3000))]);
    const handle = await ws.runtime.exec("print", { encoding: "utf8" });
    let streamed = "";
    let exit: WorkspaceRuntimeEvent<"utf8"> | undefined;
    for await (const event of handle) {
      if (event.name === "stdout") streamed += event.value;
      if (event.name === "exit") exit = event;
    }

    expect(streamed).toBe(lines(3000));
    expect(exit).toMatchObject({
      name: "exit",
      truncated: {
        stdout: { status: "saved", path: "/.computer/output/printer.run-1.stdout.log" },
      },
    });
  });

  it("takes per-run limits", async () => {
    const ws = workspaceWith(() => [encoder.encode(lines(20))]);
    const result = await (
      await ws.runtime.exec("print", { encoding: "utf8", output: { maxLines: 5 } })
    ).result();
    expect(result.stdout).toBe(lines(5, 16));
    expect(result.truncated?.stdout).toMatchObject({ firstLine: 16, totalLines: 20 });
  });

  it("keeps all output and saves nothing when output is false", async () => {
    const ws = workspaceWith(() => [encoder.encode(lines(3000))], false);
    const result = await (await ws.runtime.exec("print", { encoding: "utf8" })).result();
    expect(result.stdout).toBe(lines(3000));
    expect(result.truncated).toBeUndefined();

    const perRun = workspaceWith(() => [encoder.encode(lines(3000))]);
    const kept = await (
      await perRun.runtime.exec("print", { encoding: "utf8", output: false })
    ).result();
    expect(kept.stdout).toBe(lines(3000));
  });

  it("saves to the configured directory and keeps only the newest files", async () => {
    let now = 0;
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [printingBackend(() => [encoder.encode(lines(3000))])],
      now: () => (now += 1000),
      output: { dir: "/logs", keep: 2 },
    });
    for (let run = 0; run < 3; run += 1) {
      await (await ws.runtime.exec("print")).result();
    }
    const names = (await ws.fs.readdir("/logs")).map((entry) => entry.name).sort();
    expect(names).toEqual(["printer.run-2.stdout.log", "printer.run-3.stdout.log"]);
  });

  it("gives each backend and execution its own file", async () => {
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [
        printingBackend(() => [encoder.encode(lines(3000))], "a.b"),
        printingBackend(() => [encoder.encode(lines(3000, 7))], "a"),
      ],
    });
    const first = await (await ws.runtime.exec("print", { backend: "a.b", id: "c" })).result();
    const second = await (await ws.runtime.exec("print", { backend: "a", id: "b.c" })).result();
    const paths = [first.truncated?.stdout, second.truncated?.stdout].map((entry) =>
      entry?.status === "saved" ? entry.path : undefined,
    );
    expect(paths).toEqual([
      "/.computer/output/a%2Eb.c.stdout.log",
      "/.computer/output/a.b%2Ec.stdout.log",
    ]);
  });

  it("cleans up only its own files and keeps the newest on clock ties", async () => {
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      backends: [printingBackend(() => [encoder.encode(lines(3000))])],
      now: () => 1000,
      output: { dir: "/logs", keep: 1 },
    });
    await ws.fs.mkdir("/logs");
    await ws.fs.writeFile("/logs/notes.txt", "mine");
    for (let run = 0; run < 3; run += 1) {
      await (await ws.runtime.exec("print")).result();
    }
    const names = (await ws.fs.readdir("/logs")).map((entry) => entry.name).sort();
    expect(names).toEqual(["notes.txt", "printer.run-3.stdout.log"]);
  });

  it("closes the file when a streaming caller stops early", async () => {
    const ws = workspaceWith(() => [encoder.encode(lines(3000)), encoder.encode(lines(10))]);
    const handle = await ws.runtime.exec("print", { encoding: "utf8" });
    for await (const event of handle) {
      if (event.name === "stdout") break;
    }
    // The file holds what was read before the caller stopped, which can
    // include output read ahead of the caller.
    const saved = await ws.fs.readFile("/.computer/output/printer.run-1.stdout.log", "utf8");
    expect(saved.startsWith(lines(3000))).toBe(true);
  });

  it("rejects bad output options when the Workspace is built", () => {
    const build = (output: WorkspaceOutputOptions) => () =>
      new Workspace({ storage: new SQLiteTestStorage(), output });
    expect(build({ maxLines: 0 })).toThrow(/maxLines must be a positive integer/);
    expect(build({ maxBytes: 1.5 })).toThrow(/maxBytes must be a positive integer/);
    expect(build({ dir: "logs" })).toThrow(/absolute path/);
    expect(build({ keep: -1 })).toThrow(/keep must be a positive integer/);
  });
});

describe("OutputSpool", () => {
  it("waits for the file before taking more output", async () => {
    const written: string[] = [];
    let drain: () => void = () => {};
    const files: CommandOutputFiles = {
      open: (name) => ({
        path: `/out/${name}`,
        write: (chunk) => {
          written.push(decoder.decode(chunk));
          return new Promise((resolve) => {
            drain = resolve;
          });
        },
        close: async () => ({ _tag: "ok" }),
      }),
    };
    const spool = new OutputSpool({ maxLines: 1, maxBytes: 1024 }, files, "run.stdout.log");

    let settled = false;
    const pushed = spool.push(encoder.encode("a\nb\n")).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(written).toEqual(["a\nb\n"]);
    expect(settled).toBe(false);
    drain();
    await pushed;
    expect(settled).toBe(true);
  });
});
