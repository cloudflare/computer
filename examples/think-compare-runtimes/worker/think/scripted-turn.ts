import type { RunEventRecorder } from "../run-events";
import type { RuntimeAdapter } from "../runtime/adapter";
import { createRuntimeThinkTools, executeRuntimeThinkTool } from "./runtime-tools";

export interface ScriptedThinkToolSmokeOptions {
  adapter: RuntimeAdapter;
  recorder: RunEventRecorder;
  root: string;
}

export async function runScriptedThinkToolSmoke({
  adapter,
  recorder,
  root,
}: ScriptedThinkToolSmokeOptions): Promise<void> {
  const runtime = adapter.runtime;
  const tools = createRuntimeThinkTools({ adapter, recorder });

  recorder.record({
    runtime,
    kind: "agent_message",
    title: "Scripted Think turn started",
    detail: "Deterministic harness is exercising the Think-facing tool surface.",
  });

  await executeRuntimeThinkTool(tools, "read", {
    path: `${root}/feature-briefs/smart-request-policies.md`,
  });
  await executeRuntimeThinkTool(tools, "write", {
    path: `${root}/THINK_NOTES.md`,
    contents: "Think tool smoke: pending\n",
  });
  await executeRuntimeThinkTool(tools, "edit", {
    path: `${root}/THINK_NOTES.md`,
    edits: [{ oldText: "pending", newText: "done" }],
  });
  await executeRuntimeThinkTool(tools, "exec", { command: "node --version" });

  recorder.record({
    runtime,
    kind: "agent_message",
    title: "Scripted Think turn complete",
    detail: "Think-facing tools completed through the runtime adapter.",
  });
}
