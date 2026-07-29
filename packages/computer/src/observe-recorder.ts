// Test-only observer that records every span its callbacks open and
// reproduces parent / child nesting via a simple stack. Lives in a
// non-test source file so the integration tests can share it without
// tripping Biome's `noExportsInTest` rule.
//
// Not exported from the package's public entry point (`index.ts`) — it
// is plumbing for the workspace's own tests and for downstream callers
// who want a recording observer in their own tests against a workspace.

import type { WorkspaceAttributes, WorkspaceObserver, WorkspaceSpan } from "./observe.js";

export interface RecordedSpan {
  name: string;
  attributes: Record<string, boolean | number | string>;
  outcome: "ok" | "error";
  errorMessage?: string;
  children: RecordedSpan[];
}

export interface RecordingObserver extends WorkspaceObserver {
  readonly spans: RecordedSpan[];
}

export function makeRecorder(): RecordingObserver {
  const roots: RecordedSpan[] = [];
  const stack: RecordedSpan[] = [];
  const observer: WorkspaceObserver = {
    async span(name, attributes, run) {
      const entry: RecordedSpan = {
        name,
        attributes: filterAttributes(attributes),
        outcome: "ok",
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(entry);
      else roots.push(entry);
      stack.push(entry);
      const span: WorkspaceSpan = {
        setAttribute(key, value) {
          if (value === undefined) return;
          entry.attributes[key] = value;
        },
      };
      try {
        return await run(span);
      } catch (error) {
        entry.outcome = "error";
        entry.errorMessage = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        stack.pop();
      }
    },
  };
  return Object.assign(observer, { spans: roots });
}

function filterAttributes(input: WorkspaceAttributes): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
