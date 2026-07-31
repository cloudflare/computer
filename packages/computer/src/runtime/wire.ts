import type { ExecEncoding } from "../shell.js";
import type { WorkspaceRuntimeEvent, WorkspaceRuntimeValue } from "./types.js";

type RuntimeFrame =
  | { id: string; seq: number; name: "stdout" | "stderr"; enc: "utf8"; value: string }
  | { id: string; seq: number; name: "stdout" | "stderr"; enc: "b64"; value: string }
  | { id: string; seq: number; name: "result"; value: WorkspaceRuntimeValue }
  | { id: string; seq: number; name: "exit"; value: number };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function encodeRuntimeEvent(event: WorkspaceRuntimeEvent<ExecEncoding>): Uint8Array {
  let frame: RuntimeFrame;
  if (event.name === "exit" || event.name === "result") frame = event;
  else if (typeof event.value === "string") {
    frame = { id: event.id, seq: event.seq, name: event.name, enc: "utf8", value: event.value };
  } else {
    frame = {
      id: event.id,
      seq: event.seq,
      name: event.name,
      enc: "b64",
      value: toBase64(event.value),
    };
  }
  return new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
}

function decodeFrame(frame: RuntimeFrame): WorkspaceRuntimeEvent<ExecEncoding> {
  if (frame.name === "exit" || frame.name === "result") return frame;
  return {
    id: frame.id,
    seq: frame.seq,
    name: frame.name,
    value: frame.enc === "utf8" ? frame.value : fromBase64(frame.value),
  };
}

export function decodeRuntimeEvents(
  source: ReadableStream<Uint8Array>,
): ReadableStream<WorkspaceRuntimeEvent<ExecEncoding>> {
  const decoder = new TextDecoder();
  let buffered = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, WorkspaceRuntimeEvent<ExecEncoding>>({
      transform(chunk, controller) {
        buffered += decoder.decode(chunk, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line) controller.enqueue(decodeFrame(JSON.parse(line) as RuntimeFrame));
        }
      },
      flush(controller) {
        buffered += decoder.decode();
        if (buffered.trim()) controller.enqueue(decodeFrame(JSON.parse(buffered) as RuntimeFrame));
      },
    }),
  );
}
