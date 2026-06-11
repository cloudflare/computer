/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface WranglerContainerConfig {
  class_name: string;
  image?: string;
  instance_type?: string;
  max_instances?: number;
}

interface WranglerConfig {
  vars?: Record<string, string>;
  triggers?: { crons?: string[] };
  containers: WranglerContainerConfig[];
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  worker_loaders?: Array<{ binding: string }>;
}

describe("wrangler config", () => {
  test("enables Sandbox SDK RPC transport through Worker vars", () => {
    const config = readWranglerConfig();

    expect(config.vars).toMatchObject({ SANDBOX_TRANSPORT: "rpc" });
  });

  test("configures the Workspace worker shell loader", () => {
    const config = readWranglerConfig();

    expect(config.worker_loaders).toEqual([{ binding: "LOADER" }]);
  });

  test("uses standard containers with ten instances", () => {
    const config = readWranglerConfig();

    expect(containerConfig(config, "WorkspaceContainerHost")).toMatchObject({
      instance_type: "standard-1",
      max_instances: 10,
    });
    expect(containerConfig(config, "Sandbox")).toMatchObject({
      instance_type: "standard-1",
      max_instances: 10,
    });
  });

  test("configures container warm pools", () => {
    const config = readWranglerConfig();

    expect(config.vars).toMatchObject({
      CONTAINER_SLEEP_AFTER: "2m",
      WARM_POOL_REFRESH_INTERVAL: "10000",
      WARM_POOL_RESET_KEY: "2026-06-05-container-cleanup-v3",
      WARM_POOL_TARGET: "4",
    });
    expect(durableObjectBindingNames(config)).toEqual(
      expect.arrayContaining(["WorkspaceWarmPool", "SandboxWarmPool"]),
    );
    expect(config.triggers?.crons).toEqual(["* * * * *"]);
  });
});

function containerConfig(
  config: WranglerConfig,
  className: string,
): WranglerContainerConfig | undefined {
  return config.containers.find((container) => container.class_name === className);
}

function durableObjectBindingNames(config: WranglerConfig): string[] {
  return config.durable_objects.bindings.map((binding) => binding.name);
}

function readWranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("../wrangler.jsonc", import.meta.url).pathname, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function stripJsonComments(input: string): string {
  return input.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|\s)\/\/.*$/gm, "$1");
}
