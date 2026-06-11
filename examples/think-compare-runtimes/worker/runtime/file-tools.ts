import type { RuntimeId } from "../../shared/events";
import type { RunEventRecorderLike } from "../run-events";

export interface RuntimeFileStore {
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string): Promise<void>;
}

export interface ExactEdit {
  oldText: string;
  newText: string;
}

export interface RuntimeFileTools {
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
  edit(path: string, edits: ExactEdit[]): Promise<void>;
}

export interface RuntimeFileToolsOptions {
  runtime: RuntimeId;
  store: RuntimeFileStore;
  recorder: RunEventRecorderLike;
}

export function createRuntimeFileTools({
  runtime,
  store,
  recorder,
}: RuntimeFileToolsOptions): RuntimeFileTools {
  return {
    async read(path) {
      await recorder.record({
        runtime,
        kind: "tool_call",
        title: `read ${path}`,
        detail: `Reading file through ${runtime} runtime.`,
      });
      try {
        const contents = await store.readFile(path);
        await recorder.record({
          runtime,
          kind: "tool_result",
          title: "read complete",
          detail: `Read ${byteLength(contents)} bytes from ${path}.`,
        });
        return contents;
      } catch (error) {
        await recordToolError(recorder, runtime, "read failed", error);
        throw error;
      }
    },

    async write(path, contents) {
      await recorder.record({
        runtime,
        kind: "tool_call",
        title: `write ${path}`,
        detail: `Writing ${byteLength(contents)} bytes through ${runtime} runtime.`,
      });
      try {
        await store.writeFile(path, contents);
        await recorder.record({
          runtime,
          kind: "tool_result",
          title: "write complete",
          detail: `Wrote ${path}.`,
        });
      } catch (error) {
        await recordToolError(recorder, runtime, "write failed", error);
        throw error;
      }
    },

    async edit(path, edits) {
      await recorder.record({
        runtime,
        kind: "tool_call",
        title: `edit ${path}`,
        detail: `Applying ${edits.length} exact replacement(s) through ${runtime} runtime.`,
      });
      try {
        const contents = await store.readFile(path);
        const updated = applyExactEdits(contents, edits);
        await store.writeFile(path, updated);
        await recorder.record({
          runtime,
          kind: "tool_result",
          title: "edit complete",
          detail: `Applied ${edits.length} replacement(s) to ${path}.`,
        });
      } catch (error) {
        await recordToolError(recorder, runtime, "edit failed", error);
        throw error;
      }
    },
  };
}

function applyExactEdits(contents: string, edits: ExactEdit[]): string {
  let updated = contents;

  for (const edit of edits) {
    const first = updated.indexOf(edit.oldText);
    const last = updated.lastIndexOf(edit.oldText);

    if (edit.oldText.length === 0 || first === -1 || first !== last) {
      throw new Error(`oldText must match exactly once: ${JSON.stringify(edit.oldText)}`);
    }

    updated = `${updated.slice(0, first)}${edit.newText}${updated.slice(first + edit.oldText.length)}`;
  }

  return updated;
}

async function recordToolError(
  recorder: RunEventRecorderLike,
  runtime: RuntimeId,
  title: string,
  error: unknown,
): Promise<void> {
  await recorder.record({
    runtime,
    kind: "tool_error",
    title,
    detail: error instanceof Error ? error.message : String(error),
  });
}

function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}
