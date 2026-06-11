import type { RuntimeId } from "../../shared/events";
import type { RunEventRecorderLike } from "../run-events";

export interface RuntimeExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

export interface RuntimeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeCommandRunner {
  exec(command: string, options?: RuntimeExecOptions): Promise<RuntimeExecResult>;
}

export type RuntimeExecTool = (
  command: string,
  options?: RuntimeExecOptions,
) => Promise<RuntimeExecResult>;

export interface RuntimeExecToolOptions {
  runtime: RuntimeId;
  runner: RuntimeCommandRunner;
  recorder: RunEventRecorderLike;
}

export function createRuntimeExecTool({
  runtime,
  runner,
  recorder,
}: RuntimeExecToolOptions): RuntimeExecTool {
  return async (command, options) => {
    await recorder.record({
      runtime,
      kind: "tool_call",
      title: `exec ${command}`,
      detail: execCallDetail(runtime, options),
    });

    try {
      const result = await runner.exec(command, options);
      await recorder.record({
        runtime,
        kind: "tool_result",
        title: "exec complete",
        detail: `Exit ${result.exitCode}; stdout ${byteLength(result.stdout)} bytes; stderr ${byteLength(result.stderr)} bytes.`,
      });
      return result;
    } catch (error) {
      await recorder.record({
        runtime,
        kind: "tool_error",
        title: "exec failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function execCallDetail(runtime: RuntimeId, options: RuntimeExecOptions | undefined): string {
  const location = options?.cwd ? ` in ${options.cwd}` : "";
  return `Running command${location} through ${runtime} runtime.`;
}

function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}
