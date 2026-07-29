import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, onTestFinished, test } from "vitest";

// Pure logger primitives: a single appendToLogFile that's idempotent
// over a file handle and a formatError that surfaces stack traces.
// Wiring into console.{log,error} and into process.on('uncaughtException')
// lives in computerd.ts and is exercised end-to-end in computerd.test.ts; the unit
// tests here pin the helper contract so a regression on either side
// can be diagnosed without booting the daemon.

import { createFileLogger, formatLogEntry, installLogging } from "./logger.js";

test("formatLogEntry: stringifies primitives and Error objects", () => {
  expect(formatLogEntry("info", ["plain string"])).toMatch(/plain string/);
  expect(formatLogEntry("info", [42, "and", true])).toMatch(/42 and true/);
  const err = new Error("boom");
  const out = formatLogEntry("error", [err]);
  expect(out).toMatch(/Error: boom/);
  expect(out).toMatch(/at /); // stack frame
});

test("formatLogEntry: prefixes with ISO timestamp and level", () => {
  const out = formatLogEntry("info", ["hi"]);
  // ISO date prefix + level tag.
  expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(out).toMatch(/\[info\]/);
  const errOut = formatLogEntry("error", ["bad"]);
  expect(errOut).toMatch(/\[error\]/);
});

test("createFileLogger: appends entries to the given path", async (_ctx) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "computerd-logger-"));
  const logPath = path.join(dir, "computerd.log");
  onTestFinished(() => fsp.rm(dir, { recursive: true, force: true }));

  const logger = createFileLogger(logPath);
  logger.write("info", ["first"]);
  logger.write("error", ["second"]);
  logger.close();

  const contents = await fsp.readFile(logPath, "utf8");
  expect(contents).toMatch(/\[info\] first/);
  expect(contents).toMatch(/\[error\] second/);
});

test("createFileLogger: appends (does not truncate) when reopening", async (_ctx) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "computerd-logger-"));
  const logPath = path.join(dir, "computerd.log");
  onTestFinished(() => fsp.rm(dir, { recursive: true, force: true }));

  // Seed with a prior session.
  await fsp.writeFile(logPath, "previous session\n", "utf8");

  const logger = createFileLogger(logPath);
  logger.write("info", ["new line"]);
  logger.close();

  const contents = await fsp.readFile(logPath, "utf8");
  expect(contents).toMatch(/previous session/);
  expect(contents).toMatch(/new line/);
});

test("createFileLogger: creates the file if it doesn't exist", async (_ctx) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "computerd-logger-"));
  const logPath = path.join(dir, "nested/computerd.log");
  onTestFinished(() => fsp.rm(dir, { recursive: true, force: true }));

  const logger = createFileLogger(logPath);
  logger.write("info", ["hello"]);
  logger.close();

  expect(fs.existsSync(logPath)).toBeTruthy();
});

test("installLogging: mirrors console.{log,error} into the log file", async (_t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "computerd-logger-"));
  const logPath = path.join(dir, "computerd.log");
  onTestFinished(() => fsp.rm(dir, { recursive: true, force: true }));

  const teardown = installLogging(logPath);
  try {
    console.log("info via console.log");
    console.error("error via console.error");
  } finally {
    teardown();
  }

  const contents = await fsp.readFile(logPath, "utf8");
  expect(contents).toMatch(/\[info\] info via console\.log/);
  expect(contents).toMatch(/\[error\] error via console\.error/);
});

test("installLogging: restores console methods on teardown", () => {
  const originalLog = console.log;
  const originalError = console.error;
  const teardown = installLogging(undefined);
  // Without a LOG_FILE the install still wraps the console methods
  // (so uncaught handlers see the same formatting); teardown restores.
  expect(console.log).not.toBe(originalLog);
  expect(console.error).not.toBe(originalError);
  teardown();
  expect(console.log).toBe(originalLog);
  expect(console.error).toBe(originalError);
});

test("installLogging: uncaughtException handler writes to LOG_FILE before exit", async (_ctx) => {
  // Spawn a tiny Node script that imports installLogging, then
  // throws asynchronously to trigger uncaughtException. The exit
  // code should be 1 and the log file should contain the formatted
  // error.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "computerd-logger-"));
  const logPath = path.join(dir, "computerd.log");
  const scriptPath = path.join(dir, "crash.cjs");
  onTestFinished(() => fsp.rm(dir, { recursive: true, force: true }));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const loggerPath = path.resolve(here, "../../dist/cli/logger.js");
  const script = [
    `const { installLogging } = require(${JSON.stringify(loggerPath)});`,
    `installLogging(${JSON.stringify(logPath)});`,
    `setImmediate(() => { throw new Error("deliberate crash"); });`,
  ].join("\n");
  await fsp.writeFile(scriptPath, script, "utf8");

  const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "ignore", "pipe"] });
  const code = await new Promise((resolve) => {
    child.once("exit", (c) => resolve(c));
  });
  expect(code).toBe(1);
  const contents = await fsp.readFile(logPath, "utf8");
  expect(contents).toMatch(/uncaughtException/);
  expect(contents).toMatch(/deliberate crash/);
});
