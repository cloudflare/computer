// Minimal logger primitives for computerd. Two responsibilities:
//
//   1. formatLogEntry turns a console-shaped argv (mixed primitives,
//      objects, Errors) into a single line prefixed with an ISO
//      timestamp and a level tag.
//   2. createFileLogger opens a file for append-only writes and
//      exposes write(level, args) / close(). Computerd patches
//      console.{log,error} on top of these so the daemon's stdout/
//      stderr also lands in LOG_FILE when set.
//
// Kept in its own module so the contract is unit-testable without
// spawning the binary; cli/computerd.ts wires it up.

import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

export type LogLevel = "info" | "error";

export interface FileLogger {
  write(level: LogLevel, args: unknown[]): void;
  close(): void;
}

export function formatLogEntry(level: LogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const body = args
    .map((arg) => {
      if (arg instanceof Error) {
        return arg.stack ?? `${arg.name}: ${arg.message}`;
      }
      if (typeof arg === "string") return arg;
      return inspect(arg, { depth: 4, breakLength: 120 });
    })
    .join(" ");
  return `${timestamp} [${level}] ${body}`;
}

// Open the log file in append mode. The fd survives across writes so
// we don't pay an open/close per line. Throws if the path's directory
// can't be created.
export function createFileLogger(filePath: string): FileLogger {
  mkdirSync(dirname(filePath), { recursive: true });
  // O_APPEND | O_CREAT | O_WRONLY = 'a' in node's flag shorthand.
  const fd = openSync(filePath, "a");
  let closed = false;
  return {
    write(level, args) {
      if (closed) return;
      const line = `${formatLogEntry(level, args)}\n`;
      writeSync(fd, line);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // Already closed or filesystem went away. Either way,
        // nothing useful to do; the process is likely exiting.
      }
    },
  };
}

// Patch console.{log, error} so each call also lands in LOG_FILE,
// then install handlers for uncaughtException and unhandledRejection
// so a stray throw leaves a record before the process exits. Both
// pieces are no-ops when logFilePath is undefined (the daemon still
// logs to stdout/stderr).
//
// Returns a teardown closure: removes the listeners, restores the
// original console methods, and closes the file handle. Calling it
// is optional — the OS closes the fd on process exit anyway.
export function installLogging(logFilePath: string | undefined): () => void {
  const file: FileLogger | undefined =
    logFilePath !== undefined && logFilePath !== "" ? createFileLogger(logFilePath) : undefined;
  // Save the original methods unbound so teardown can restore the
  // exact same references the caller had pre-install. The wrappers
  // call through bind() copies so they don't reenter themselves.
  const originalLog = console.log;
  const originalError = console.error;
  const callLog = originalLog.bind(console);
  const callError = originalError.bind(console);
  const writeBoth = (level: LogLevel, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]): void => {
      original(...args);
      file?.write(level, args);
    };
  };
  console.log = writeBoth("info", callLog);
  console.error = writeBoth("error", callError);

  const onUncaught = (err: unknown): void => {
    console.error("uncaughtException:", err);
    process.exit(1);
  };
  const onUnhandled = (reason: unknown): void => {
    console.error("unhandledRejection:", reason);
    process.exit(1);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUnhandled);

  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onUnhandled);
    console.log = originalLog;
    console.error = originalError;
    file?.close();
  };
}
