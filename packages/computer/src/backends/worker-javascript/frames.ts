import type { WorkspaceRuntimeValue } from "../../runtime/types.js";

export type RuntimeFrame =
  | { name: "stdout"; value: Uint8Array }
  | { name: "stderr"; value: Uint8Array }
  | { name: "exit"; code: number; result?: WorkspaceRuntimeValue };

export function parseRuntimeFrame(line: string): RuntimeFrame {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error("WorkerJavaScriptBackend received an invalid execution frame");
  }
  const name = record.name;
  if (name === "stdout" || name === "stderr") {
    if (typeof record.b64 !== "string") {
      throw new Error("WorkerJavaScriptBackend received a malformed output frame");
    }
    return { name, value: decodeBase64(record.b64) };
  }
  if (name === "exit") {
    if (!Number.isSafeInteger(record.code)) {
      throw new Error("WorkerJavaScriptBackend received a malformed exit frame");
    }
    if ("result" in record) {
      return {
        name,
        code: record.code as number,
        result: record.result as WorkspaceRuntimeValue,
      };
    }
    return { name, code: record.code as number };
  }
  throw new Error("WorkerJavaScriptBackend received an unknown execution frame");
}

export function decodeRuntimeFrames(
  source: ReadableStream<Uint8Array>,
): ReadableStream<RuntimeFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = (controller: TransformStreamDefaultController<RuntimeFrame>, final: boolean) => {
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) controller.enqueue(parseRuntimeFrame(line));
      nl = buffer.indexOf("\n");
    }
    if (final && buffer.length > 0) {
      controller.enqueue(parseRuntimeFrame(buffer));
      buffer = "";
    }
  };
  return source.pipeThrough(
    new TransformStream<Uint8Array, RuntimeFrame>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        drain(controller, false);
      },
      flush(controller) {
        buffer += decoder.decode();
        drain(controller, true);
      },
    }),
  );
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
