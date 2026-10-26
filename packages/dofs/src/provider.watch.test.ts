import type { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { withDB } from "./fs/with-db";
import { SQLiteWorkspaceProvider } from "./provider";

interface WatchEmitter extends EventEmitter {
  close(): void;
}

interface WatchEvent {
  eventType: "rename" | "change";
  filename: string;
}

async function withProvider<T>(fn: (p: SQLiteWorkspaceProvider) => T | Promise<T>): Promise<T> {
  return withDB((db) =>
    fn(new SQLiteWorkspaceProvider(db, { now: () => 1000, watchIntervalMs: 25 })),
  );
}

async function nextEvents(
  watcher: WatchEmitter,
  count: number,
  timeoutMs = 1500,
): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const onChange = (eventType: "rename" | "change", filename: string) => {
      events.push({ eventType, filename });
      if (events.length >= count) {
        watcher.off("change", onChange);
        resolve();
      }
    };
    watcher.on("change", onChange);
    setTimeout(() => {
      watcher.off("change", onChange);
      reject(new Error(`timed out waiting for ${count} events; got ${events.length}`));
    }, timeoutMs);
  });
  await done;
  return events;
}

describe("SQLiteWorkspaceProvider — watch", () => {
  it("supportsWatch is true", async () => {
    await withProvider((p) => {
      expect(p.supportsWatch).toBe(true);
    });
  });

  it("watch(dir) fires for a write to a direct child", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/d", {});
      const w = p.watch("/d", {}) as WatchEmitter;
      try {
        // Write happens after the watcher captures the baseline rev.
        // Give the poll loop one tick to record the initial position.
        await new Promise((r) => setTimeout(r, 30));
        p.writeFileSync("/d/a.txt", "hello");
        const events = await nextEvents(w, 1);
        expect(events[0]).toMatchObject({ filename: "a.txt" });
      } finally {
        w.close();
      }
    });
  });

  it("watch(dir, { recursive: true }) fires for nested writes", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/d", {});
      p.mkdirSync("/d/sub", {});
      const w = p.watch("/d", { recursive: true }) as WatchEmitter;
      try {
        await new Promise((r) => setTimeout(r, 30));
        p.writeFileSync("/d/sub/deep.txt", "yo");
        const events = await nextEvents(w, 1);
        expect(events[0].filename).toBe("sub/deep.txt");
      } finally {
        w.close();
      }
    });
  });

  it("watch(dir) does not fire for unrelated writes", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/watched", {});
      p.mkdirSync("/other", {});
      const w = p.watch("/watched", {}) as WatchEmitter;
      const seen: string[] = [];
      const onChange = (_t: string, name: string) => seen.push(name);
      w.on("change", onChange);
      try {
        await new Promise((r) => setTimeout(r, 30));
        p.writeFileSync("/other/x.txt", "no");
        await new Promise((r) => setTimeout(r, 100));
        expect(seen).toEqual([]);
      } finally {
        w.off("change", onChange);
        w.close();
      }
    });
  });

  it("watch fires rename for a delete and change for a write", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/d", {});
      p.writeFileSync("/d/a.txt", "first");
      const w = p.watch("/d", {}) as WatchEmitter;
      try {
        await new Promise((r) => setTimeout(r, 30));
        p.writeFileSync("/d/a.txt", "second");
        const first = await nextEvents(w, 1);
        expect(first[0].eventType).toBe("change");
        // Separate tick so coalescing doesn't collapse the
        // write and the delete into a single delete entry.
        await new Promise((r) => setTimeout(r, 50));
        p.unlinkSync("/d/a.txt");
        const second = await nextEvents(w, 1);
        expect(second[0].eventType).toBe("rename");
      } finally {
        w.close();
      }
    });
  });

  it("watch.close() stops the poll loop", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/d", {});
      const w = p.watch("/d", {}) as WatchEmitter;
      w.close();
      const seen: string[] = [];
      w.on("change", (_t, name) => seen.push(name));
      await new Promise((r) => setTimeout(r, 50));
      p.writeFileSync("/d/a.txt", "noop");
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
    });
  });

  it("watchAsync yields events via for-await", async () => {
    await withProvider(async (p) => {
      p.mkdirSync("/d", {});
      const it = p.watchAsync("/d", {}) as AsyncIterable<WatchEvent> & {
        return(): Promise<unknown>;
      };
      const iter = it[Symbol.asyncIterator]() as AsyncIterator<WatchEvent>;
      try {
        await new Promise((r) => setTimeout(r, 30));
        p.writeFileSync("/d/a.txt", "x");
        const { value } = await iter.next();
        expect(value).toMatchObject({ filename: "a.txt" });
      } finally {
        await iter.return?.(undefined);
      }
    });
  });
});
