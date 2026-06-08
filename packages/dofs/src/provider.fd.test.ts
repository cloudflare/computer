// File descriptor / positional I/O tests for SQLiteWorkspaceProvider.
// Separate file so the read/write coverage can grow without bloating
// the scaffold test file.

import { describe, expect, it } from "vitest";

import { resolveInode } from "./fs/resolve.js";
import { withDB } from "./fs/with-db.js";
import { SQLiteWorkspaceProvider } from "./provider.js";

async function withProvider<T>(fn: (p: SQLiteWorkspaceProvider) => T | Promise<T>): Promise<T> {
  return withDB((db) => fn(new SQLiteWorkspaceProvider(db, { now: () => 1000 })));
}

// 512 KiB to match writeFile's CHUNK_SIZE so tests can deliberately
// straddle chunk boundaries.
const CHUNK_SIZE = 512 * 1024;

function chunkHashes(p: SQLiteWorkspaceProvider, path: string): Buffer[] {
  const node = resolveInode(p.db, path);
  if (node === null) throw new Error(`missing node: ${path}`);
  return p.db
    .all<{ hash: Uint8Array }>(
      "SELECT hash FROM vfs_chunks WHERE inode = ? ORDER BY idx",
      node.inode,
    )
    .map((row) => Buffer.from(row.hash));
}

describe("SQLiteWorkspaceProvider — file descriptors", () => {
  it("openSync allocates a positive integer", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      const fd = p.openSync("/a", "r");
      expect(typeof fd).toBe("number");
      expect((fd as number) > 0).toBe(true);
      p.closeSync(fd as number);
    });
  });

  it("openSync('r') on a missing file throws ENOENT", async () => {
    await withProvider((p) => {
      expect(() => p.openSync("/missing", "r")).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("openSync('w') creates a missing file as empty", async () => {
    await withProvider((p) => {
      const fd = p.openSync("/new", "w");
      expect(p.existsSync("/new")).toBe(true);
      expect(p.statSync("/new").size).toBe(0);
      p.closeSync(fd as number);
    });
  });

  it("openSync('w') truncates an existing file", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "before");
      const fd = p.openSync("/a", "w");
      expect(p.statSync("/a").size).toBe(0);
      p.closeSync(fd as number);
    });
  });

  it("openSync('a') opens for append without truncating", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      const fd = p.openSync("/a", "a");
      expect(p.statSync("/a").size).toBe(5);
      p.closeSync(fd as number);
    });
  });

  it("closeSync on an unknown fd throws EBADF", async () => {
    await withProvider((p) => {
      expect(() => p.closeSync(9999)).toThrowError(expect.objectContaining({ code: "EBADF" }));
    });
  });

  it("fstatSync mirrors statSync for the fd's path", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello", { mode: 0o644 });
      const fd = p.openSync("/a", "r") as number;
      const s = p.fstatSync(fd);
      expect(s.size).toBe(5);
      expect(s.isFile()).toBe(true);
      p.closeSync(fd);
    });
  });
});

describe("SQLiteWorkspaceProvider — readSync", () => {
  it("reads from the fd's position when position is null", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello workspace");
      const fd = p.openSync("/a", "r") as number;
      const buf = Buffer.alloc(5);
      const n = p.readSync(fd, buf, 0, 5, null);
      expect(n).toBe(5);
      expect(buf.toString()).toBe("hello");
      // Position advanced; next read continues.
      const n2 = p.readSync(fd, buf, 0, 5, null);
      expect(n2).toBe(5);
      expect(buf.toString()).toBe(" work");
      p.closeSync(fd);
    });
  });

  it("reads at an explicit position without moving the fd", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello workspace");
      const fd = p.openSync("/a", "r") as number;
      const buf = Buffer.alloc(5);
      const n = p.readSync(fd, buf, 0, 5, 6);
      expect(n).toBe(5);
      expect(buf.toString()).toBe("works");
      // Fd position unchanged: still at 0.
      p.readSync(fd, buf, 0, 5, null);
      expect(buf.toString()).toBe("hello");
      p.closeSync(fd);
    });
  });

  it("returns 0 when reading past EOF", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "tiny");
      const fd = p.openSync("/a", "r") as number;
      const buf = Buffer.alloc(10);
      expect(p.readSync(fd, buf, 0, 10, 100)).toBe(0);
      p.closeSync(fd);
    });
  });

  it("respects the buffer offset", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "abcde");
      const fd = p.openSync("/a", "r") as number;
      const buf = Buffer.alloc(10).fill(0x2e); // '.'
      const n = p.readSync(fd, buf, 3, 5, 0);
      expect(n).toBe(5);
      expect(buf.toString()).toBe("...abcde..");
      p.closeSync(fd);
    });
  });

  it("reads across a chunk boundary", async () => {
    await withProvider((p) => {
      // Build a file that crosses one 512KiB boundary.
      const bytes = new Uint8Array(CHUNK_SIZE + 100);
      bytes.fill(0x41);
      for (let i = CHUNK_SIZE; i < bytes.byteLength; i++) bytes[i] = 0x42;
      p.writeFileSync("/big", Buffer.from(bytes));
      const fd = p.openSync("/big", "r") as number;
      const buf = Buffer.alloc(200);
      // Straddle the boundary: read 200 bytes starting 100 bytes before it.
      const n = p.readSync(fd, buf, 0, 200, CHUNK_SIZE - 100);
      expect(n).toBe(200);
      // First 100 bytes are 'A' (pre-boundary), remaining 100 are 'B'.
      for (let i = 0; i < 100; i++) expect(buf[i]).toBe(0x41);
      for (let i = 100; i < 200; i++) expect(buf[i]).toBe(0x42);
      p.closeSync(fd);
    });
  });
});

describe("SQLiteWorkspaceProvider — direct range methods", () => {
  it("exposes direct create, write range, and truncate methods", async () => {
    await withProvider((p) => {
      p.createFileSync("/direct.txt", { mode: 0o600 });
      expect(p.statSync("/direct.txt").mode & 0o777).toBe(0o600);

      expect(p.writeRangeSync("/direct.txt", Buffer.from("abcdef"), 0)).toBe(6);
      expect(p.writeRangeSync("/direct.txt", Buffer.from("Z"), 3)).toBe(1);
      expect(p.readFileSync("/direct.txt", "utf8")).toBe("abcZef");

      p.truncateFileSync("/direct.txt", 4);
      expect(p.readFileSync("/direct.txt", "utf8")).toBe("abcZ");
    });
  });
});

describe("SQLiteWorkspaceProvider — writeSync", () => {
  it("writes at position 0 and updates content", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      const fd = p.openSync("/a", "r+") as number;
      const n = p.writeSync(fd, Buffer.from("HELLO"), 0, 5, 0);
      expect(n).toBe(5);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("HELLO");
    });
  });

  it("writes at a non-zero offset", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello world");
      const fd = p.openSync("/a", "r+") as number;
      p.writeSync(fd, Buffer.from("WORLD"), 0, 5, 6);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("hello WORLD");
    });
  });

  it("extends the file when writing past EOF", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hi");
      const fd = p.openSync("/a", "r+") as number;
      p.writeSync(fd, Buffer.from("bye"), 0, 3, 2);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("hibye");
    });
  });

  it("zero-fills the gap when writing past current size", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "ab");
      const fd = p.openSync("/a", "r+") as number;
      p.writeSync(fd, Buffer.from("z"), 0, 1, 5);
      p.closeSync(fd);
      const stat = p.statSync("/a");
      expect(stat.size).toBe(6);
      const out = p.readFileSync("/a") as Buffer;
      expect(out[0]).toBe(0x61); // 'a'
      expect(out[1]).toBe(0x62); // 'b'
      expect(out[2]).toBe(0);
      expect(out[3]).toBe(0);
      expect(out[4]).toBe(0);
      expect(out[5]).toBe(0x7a); // 'z'
    });
  });

  it("advances the fd position when position is null", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "");
      const fd = p.openSync("/a", "w") as number;
      p.writeSync(fd, Buffer.from("abc"), 0, 3, null);
      p.writeSync(fd, Buffer.from("def"), 0, 3, null);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("abcdef");
    });
  });

  it("writes across a chunk boundary, splicing in the affected chunks only", async () => {
    await withProvider((p) => {
      const before = new Uint8Array(CHUNK_SIZE + 100);
      before.fill(0x41);
      for (let i = CHUNK_SIZE; i < before.byteLength; i++) before[i] = 0x42;
      p.writeFileSync("/big", Buffer.from(before));

      const fd = p.openSync("/big", "r+") as number;
      // Overwrite 200 bytes that straddle the boundary with 'Z'.
      const stamp = Buffer.alloc(200, 0x5a);
      p.writeSync(fd, stamp, 0, 200, CHUNK_SIZE - 100);
      p.closeSync(fd);

      const out = p.readFileSync("/big") as Buffer;
      expect(out.byteLength).toBe(CHUNK_SIZE + 100);
      expect(out[0]).toBe(0x41);
      expect(out[CHUNK_SIZE - 101]).toBe(0x41);
      expect(out[CHUNK_SIZE - 100]).toBe(0x5a);
      expect(out[CHUNK_SIZE + 99]).toBe(0x5a);
      // Anything past the overwrite is whatever remained of 'B'.
      // (The original had only 100 B-bytes total, all of which we overwrote.)
    });
  });

  it("reuses untouched chunk rows for positional writes", async () => {
    await withProvider((p) => {
      const before = new Uint8Array(CHUNK_SIZE * 3);
      before.fill(1, 0, CHUNK_SIZE);
      before.fill(2, CHUNK_SIZE, CHUNK_SIZE * 2);
      before.fill(3, CHUNK_SIZE * 2);
      p.writeFileSync("/big", Buffer.from(before));
      const oldHashes = chunkHashes(p, "/big");

      const fd = p.openSync("/big", "r+") as number;
      p.writeSync(fd, Buffer.from([9, 9, 9]), 0, 3, CHUNK_SIZE + 10);
      p.closeSync(fd);
      const newHashes = chunkHashes(p, "/big");

      expect(newHashes[0].equals(oldHashes[0])).toBe(true);
      expect(newHashes[1].equals(oldHashes[1])).toBe(false);
      expect(newHashes[2].equals(oldHashes[2])).toBe(true);
    });
  });

  it("openSync('a') starts the fd at EOF", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      const fd = p.openSync("/a", "a") as number;
      p.writeSync(fd, Buffer.from(" world"), 0, 6, null);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("hello world");
    });
  });
});

describe("SQLiteWorkspaceProvider — truncateSync / ftruncateSync", () => {
  it("truncateSync shrinks a file", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello world");
      p.truncateSync("/a", 5);
      expect(p.readFileSync("/a", "utf8")).toBe("hello");
    });
  });

  it("truncateSync grows a file with zero fill", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "abc");
      p.truncateSync("/a", 6);
      const out = p.readFileSync("/a") as Buffer;
      expect(out.byteLength).toBe(6);
      expect(out[0]).toBe(0x61);
      expect(out[3]).toBe(0);
    });
  });

  it("truncateSync to 0 leaves an empty file", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      p.truncateSync("/a", 0);
      expect(p.statSync("/a").size).toBe(0);
    });
  });

  it("truncateSync at the same size is a no-op", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello");
      p.truncateSync("/a", 5);
      expect(p.readFileSync("/a", "utf8")).toBe("hello");
    });
  });

  it("truncateSync shrinks across a chunk boundary", async () => {
    await withProvider((p) => {
      const bytes = new Uint8Array(CHUNK_SIZE + 100);
      bytes.fill(0x41);
      p.writeFileSync("/big", Buffer.from(bytes));
      p.truncateSync("/big", CHUNK_SIZE - 10);
      expect(p.statSync("/big").size).toBe(CHUNK_SIZE - 10);
    });
  });

  it("truncateSync grows across a chunk boundary", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "ab");
      p.truncateSync("/a", CHUNK_SIZE + 100);
      expect(p.statSync("/a").size).toBe(CHUNK_SIZE + 100);
      const out = p.readFileSync("/a") as Buffer;
      expect(out[0]).toBe(0x61);
      expect(out[1]).toBe(0x62);
      expect(out[2]).toBe(0);
      expect(out[CHUNK_SIZE + 99]).toBe(0);
    });
  });

  it("truncateSync on a missing file throws ENOENT", async () => {
    await withProvider((p) => {
      expect(() => p.truncateSync("/missing", 0)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("ftruncateSync mirrors truncateSync through an fd", async () => {
    await withProvider((p) => {
      p.writeFileSync("/a", "hello world");
      const fd = p.openSync("/a", "r+") as number;
      p.ftruncateSync(fd, 5);
      p.closeSync(fd);
      expect(p.readFileSync("/a", "utf8")).toBe("hello");
    });
  });
});
