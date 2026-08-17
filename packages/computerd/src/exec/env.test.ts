import { expect, test } from "vitest";

import { inheritedEnv } from "./env.js";

test("forwards the standard variables a shell environment expects", () => {
  const env = inheritedEnv({
    PATH: "/opt/toolchain/bin:/usr/bin",
    HOME: "/root",
    TMPDIR: "/tmp",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm",
  });

  expect(env).toEqual({
    PATH: "/opt/toolchain/bin:/usr/bin",
    HOME: "/root",
    TMPDIR: "/tmp",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "xterm",
  });
});

test("drops the daemon's own configuration and anything else unrecognized", () => {
  // The secret is the reason this list is an allowlist rather than a
  // denylist: a new one must not reach a spawned process by default.
  const env = inheritedEnv({
    PATH: "/usr/bin",
    RPC_CLIENT_SECRET: "sssh",
    PORT: "8080",
    MOUNT_POINT: "/workspace",
    FUSE_MOUNT: "auto",
    LOG_FILE: "/tmp/computerd.log",
    EXEC_LOG_MAX_BYTES: "1024",
    AWS_SECRET_ACCESS_KEY: "also-sssh",
  });

  expect(env).toEqual({ PATH: "/usr/bin" });
});

test("forwards COMPUTER_VAR_ values with the prefix stripped", () => {
  const env = inheritedEnv({
    COMPUTER_VAR_NODE_ENV: "production",
    COMPUTER_VAR_EMPTY: "",
  });

  expect(env).toEqual({ NODE_ENV: "production", EMPTY: "" });
});

test("lets a prefixed value replace a standard variable", () => {
  const env = inheritedEnv({
    PATH: "/usr/bin",
    COMPUTER_VAR_PATH: "/opt/only/bin",
  });

  expect(env.PATH).toBe("/opt/only/bin");
});

test("ignores a bare prefix with no name after it", () => {
  expect(inheritedEnv({ COMPUTER_VAR_: "nameless" })).toEqual({});
});

test("omits variables that are absent rather than defining them empty", () => {
  const env = inheritedEnv({ PATH: "/usr/bin", HOME: undefined });

  expect(env).toEqual({ PATH: "/usr/bin" });
  expect("HOME" in env).toBe(false);
});
