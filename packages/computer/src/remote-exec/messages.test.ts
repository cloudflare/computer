import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeResponse,
  encodeRequest,
  isRelPath,
  ProtocolError,
  type Request,
  type Response,
} from "./messages";
import { fromHex, TESTS_DIR, toHex } from "./testing/harness";
import { decodeRequest, encodeResponse } from "./testing/raw";

const GOLDEN = path.join(TESTS_DIR, "golden");
const UPDATE = process.env.UPDATE_GOLDEN !== undefined;

type Json = Record<string, unknown>;

/** JSON (bytes as hex) → message values (bytes as Uint8Array). */
function fromJson(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => fromJson(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJson(v, k)]));
  }
  return ["hash", "data", "token"].includes(key) && typeof value === "string"
    ? fromHex(value)
    : value;
}

/** Message values → JSON, for comparing against the golden spec. */
function toJson(value: unknown): unknown {
  if (value instanceof Uint8Array) return toHex(value);
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  return value;
}

function cases(file: string): { name: string; value: Json }[] {
  const raw = JSON.parse(fs.readFileSync(path.join(GOLDEN, file), "utf8")) as {
    name: string;
    request?: Json;
    response?: Json;
  }[];
  return raw.map((c) => ({ name: c.name, value: (c.request ?? c.response) as Json }));
}

describe("golden messages (shared with packages/remote-exec/src/proto.rs)", () => {
  it("encodes every request in requests.json to the committed bytes, which Rust decodes", () => {
    const list = cases("requests.json");
    expect(list.length).toBeGreaterThanOrEqual(12);
    const types = new Set(list.map((c) => c.value.type));
    expect([...types].sort()).toEqual([
      "awaitStart",
      "begin",
      "chunk",
      "close",
      "prepare",
      "pull",
      "push",
      "pushEnd",
      "signal",
    ]);
    for (const { name, value } of list) {
      const bytes = encodeRequest(fromJson(value) as Request);
      const file = path.join(GOLDEN, "requests", `${name}.bin`);
      if (UPDATE) fs.writeFileSync(file, bytes);
      expect(
        toHex(new Uint8Array(fs.readFileSync(file))),
        `requests/${name}.bin (UPDATE_GOLDEN=1 to rewrite)`,
      ).toBe(toHex(bytes));
      expect(toJson(decodeRequest(bytes)), name).toEqual(value);
    }
  });

  it("decodes every response Rust encoded (responses/*.bin) to what responses.json says", () => {
    const list = cases("responses.json");
    const types = new Set(list.map((c) => c.value.type));
    expect(types.size).toBe(11); // every Response variant
    for (const { name, value } of list) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(GOLDEN, "responses", `${name}.bin`)));
      expect(toJson(decodeResponse(bytes)), name).toEqual(value);
    }
  });
});

describe("decodeResponse validation (the container is untrusted)", () => {
  const entry = {
    path: "ok.txt",
    kind: "file",
    mode: 0o644,
    size: 1,
    hash: new Uint8Array(32),
    target: "",
  };
  const rejects = (r: Json, pattern: RegExp) => {
    expect(() => decodeResponse(encodeResponse(r as Response))).toThrow(pattern);
    expect(() => decodeResponse(encodeResponse(r as Response))).toThrow(ProtocolError);
  };

  it("accepts a well-formed changes response", () => {
    expect(
      decodeResponse(
        encodeResponse({
          type: "changes",
          changed: [entry],
          deleted: ["a/b"],
          skipped: [],
        } as Response),
      ),
    ).toMatchObject({
      type: "changes",
      changed: [{ path: "ok.txt" }],
    });
  });

  it("rejects unsafe paths wherever they appear", () => {
    for (const bad of [
      "../escape",
      "/etc/passwd",
      "a//b",
      "a/./b",
      "",
      "a\nb",
      "x/..",
      `${"a/".repeat(3000)}x`,
    ]) {
      rejects(
        { type: "changes", changed: [{ ...entry, path: bad }], deleted: [], skipped: [] },
        /safe relative path/,
      );
      rejects({ type: "changes", changed: [], deleted: [bad], skipped: [] }, /safe relative path/);
      rejects(
        { type: "pullEnd", report: { written: 0, bytes: 0, deleted: [bad], skipped: [] } },
        /safe relative path/,
      );
    }
  });

  it("rejects malformed entries, tokens and oversized text", () => {
    rejects(
      {
        type: "changes",
        changed: [{ ...entry, hash: new Uint8Array(3) }],
        deleted: [],
        skipped: [],
      },
      /32 bytes/,
    );
    rejects(
      { type: "changes", changed: [{ ...entry, kind: 7 }], deleted: [], skipped: [] },
      /entry kind/,
    );
    rejects({ type: "prepared", token: new Uint8Array(8) }, /16 bytes/);
    rejects({ type: "error", code: "x".repeat(65), message: "", errno: 0 }, /too long/);
    rejects({ type: "error", code: "io", message: "m".repeat(70_000), errno: 0 }, /too long/);
    rejects(
      {
        type: "changes",
        changed: [{ ...entry, kind: "symlink", target: "t".repeat(5000) }],
        deleted: [],
        skipped: [],
      },
      /too long/,
    );
  });

  it("keeps only permission bits of modes", () => {
    const r = decodeResponse(
      encodeResponse({
        type: "changes",
        changed: [{ ...entry, mode: 0o100755 }],
        deleted: [],
        skipped: [],
      } as Response),
    );
    expect(r.type === "changes" && r.changed[0]?.mode).toBe(0o755);
  });

  it("checks the segment table before decoding (fuzzing found an out-of-memory crash)", () => {
    // Claims ~10^9 segments: capnp-es would allocate per segment while parsing the table.
    const hostile = new Uint8Array([
      0, 0, 0, 0x3b, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 4, 0, 0, 0, 0x92, 0x10, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(() => decodeResponse(hostile)).toThrow(/segments/);
    const golden = new Uint8Array(fs.readFileSync(path.join(GOLDEN, "responses", "closed.bin")));
    expect(() => decodeResponse(golden.subarray(0, golden.byteLength - 8))).toThrow(
      /segment table says/,
    );
    expect(() => decodeResponse(new Uint8Array([...golden, 0, 0, 0, 0, 0, 0, 0, 0]))).toThrow(
      /segment table says/,
    );
  });

  it("turns undecodable bytes into ProtocolError", () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array(8),
      new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ]) {
      expect(() => decodeResponse(bytes)).toThrow(ProtocolError);
    }
  });
});

describe("fuzzing decodeResponse", () => {
  // A deterministic PRNG, so failures reproduce.
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("never throws anything but ProtocolError on mutated golden responses", () => {
    const rand = prng(0x5eed);
    const seeds = fs
      .readdirSync(path.join(GOLDEN, "responses"))
      .map((f) => new Uint8Array(fs.readFileSync(path.join(GOLDEN, "responses", f))));
    let decoded = 0;
    let rejected = 0;
    const violations: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const seed = seeds[Math.floor(rand() * seeds.length)] ?? new Uint8Array();
      const bytes = seed.slice();
      const flips = 1 + Math.floor(rand() * 4);
      for (let f = 0; f < flips; f++)
        bytes[Math.floor(rand() * bytes.length)] = Math.floor(rand() * 256);
      const mutated = rand() < 0.2 ? bytes.subarray(0, Math.floor(rand() * bytes.length)) : bytes;
      try {
        const r = decodeResponse(mutated);
        decoded++;
        // Whatever decodes must still satisfy the invariants callers rely on.
        if (r.type === "changes") {
          for (const p of [...r.changed.map((e) => e.path), ...r.deleted])
            if (!isRelPath(p)) violations.push(p);
        }
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw new Error(`iteration ${i}: ${String(error)}`);
        rejected++;
      }
    }
    expect(violations).toEqual([]);
    expect(decoded).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("never throws anything but ProtocolError on random bytes", () => {
    const rand = prng(42);
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      checked++;
      const bytes = new Uint8Array(Math.floor(rand() * 200));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(rand() * 256);
      try {
        decodeResponse(bytes);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw new Error(`iteration ${i}: ${String(error)}`);
      }
    }
    expect(checked).toBe(5000);
  });
});

describe("isRelPath", () => {
  it("matches the Rust side's check_rel", () => {
    for (const ok of ["a", "a/b.txt", ".hidden", "a/.b/c", "with space/x", "unicodé/文件"])
      expect(isRelPath(ok), ok).toBe(true);
    for (const bad of [
      "",
      "/a",
      "a/../b",
      "..",
      "a//b",
      "./a",
      "a/.",
      "a/",
      "a\nb",
      "a\0b",
      "x".repeat(4097),
    ])
      expect(isRelPath(bad), bad).toBe(false);
  });
});
