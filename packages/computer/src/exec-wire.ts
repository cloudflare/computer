// Exec event wire codec.
//
// The host-side ExecHandle is a ReadableStream<WorkspaceExecEvent>.
// Workers RPC carries byte streams with flow control but not an
// arbitrary object stream, so to project a faithful streaming exec
// across the boundary the event stream is framed as JSONL bytes on
// the durable-object side and parsed back into events on the Worker
// side.
//
// Wire shape: one JSON object per line (newline-delimited), each the
// encoding of a single event:
//
//   {"id","seq","name":"stdout","enc":"utf8","value":"..."}      string chunk
//   {"id","seq","name":"stdout","enc":"b64","value":"..."}       byte chunk
//   {"id","seq","name":"exit","value":0}                          exit code
//
// stdout/stderr values are either utf8 text (encoding: "utf8" execs)
// or raw bytes (default execs). Bytes are base64'd so the frame stays
// valid JSON regardless of the chunk's contents. Text is carried as a
// JSON string, which already escapes newlines and quotes, so a chunk
// containing newlines can't be confused with the line delimiter.
//
// This adds a serialization pass per chunk. That cost is the price of
// one faithful Workspace interface on both sides of the wire.

import type { ExecEncoding, WorkspaceExecEvent } from "./shell.js";

// JSON-friendly frame for one event. Discriminated the same way as
// WorkspaceExecEvent, plus an `enc` tag on output chunks so the
// decoder knows whether to hand back a string or a Uint8Array.
type ExecFrame =
  | { id: string; seq: number; name: "stdout" | "stderr"; enc: "utf8"; value: string }
  | { id: string; seq: number; name: "stdout" | "stderr"; enc: "b64"; value: string }
  | { id: string; seq: number; name: "exit"; value: number };

function toBase64(bytes: Uint8Array): string {
  // Chunked to avoid blowing the argument limit on String.fromCharCode
  // for large buffers.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function frameOf(event: WorkspaceExecEvent<ExecEncoding>): ExecFrame {
  if (event.name === "exit") {
    return { id: event.id, seq: event.seq, name: "exit", value: event.value };
  }
  if (typeof event.value === "string") {
    return { id: event.id, seq: event.seq, name: event.name, enc: "utf8", value: event.value };
  }
  return {
    id: event.id,
    seq: event.seq,
    name: event.name,
    enc: "b64",
    value: toBase64(event.value),
  };
}

function eventOf(frame: ExecFrame): WorkspaceExecEvent<ExecEncoding> {
  if (frame.name === "exit") {
    return { id: frame.id, seq: frame.seq, name: "exit", value: frame.value };
  }
  const value = frame.enc === "utf8" ? frame.value : fromBase64(frame.value);
  return {
    id: frame.id,
    seq: frame.seq,
    name: frame.name,
    value,
  } as WorkspaceExecEvent<ExecEncoding>;
}

const encoder = new TextEncoder();

export function encodeExecEvent(event: WorkspaceExecEvent<ExecEncoding>): Uint8Array {
  return encoder.encode(`${JSON.stringify(frameOf(event))}\n`);
}

// Frame a stream of exec events as JSONL bytes for the wire.
export function encodeExecEvents(
  events: ReadableStream<WorkspaceExecEvent<ExecEncoding>>,
): ReadableStream<Uint8Array> {
  return events.pipeThrough(
    new TransformStream<WorkspaceExecEvent<ExecEncoding>, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(encodeExecEvent(event));
      },
    }),
  );
}

// Parse a JSONL byte stream from the wire back into exec events.
// Buffers partial lines so a chunk boundary can fall anywhere.
export function decodeExecEvents<E extends ExecEncoding>(
  bytes: ReadableStream<Uint8Array>,
): ReadableStream<WorkspaceExecEvent<E>> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const emitLine = (
    line: string,
    controller: TransformStreamDefaultController<WorkspaceExecEvent<E>>,
  ) => {
    if (line.length === 0) return;
    const frame = JSON.parse(line) as ExecFrame;
    controller.enqueue(eventOf(frame) as WorkspaceExecEvent<E>);
  };
  return bytes.pipeThrough(
    new TransformStream<Uint8Array, WorkspaceExecEvent<E>>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          emitLine(buffer.slice(0, newline), controller);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        // A well-formed stream ends each event with a newline, so the
        // tail is normally empty. Emit any trailing line defensively.
        emitLine(buffer, controller);
        buffer = "";
      },
    }),
  );
}
