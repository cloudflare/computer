const DEFAULT_CONTAINER_SLEEP_AFTER = "2m";
const DEFAULT_WARM_POOL_REFRESH_INTERVAL_MS = 10_000;
const DEFAULT_WARM_POOL_TARGET = 0;

export interface ContainerPoolConfigEnv {
  CONTAINER_SLEEP_AFTER?: string;
  WARM_POOL_REFRESH_INTERVAL?: string;
  WARM_POOL_RESET_KEY?: string;
  WARM_POOL_TARGET?: string;
}

export function containerSleepAfter(env: { CONTAINER_SLEEP_AFTER?: string }): string {
  return env.CONTAINER_SLEEP_AFTER ?? DEFAULT_CONTAINER_SLEEP_AFTER;
}

export function containerSleepAfterMs(env: { CONTAINER_SLEEP_AFTER?: string }): number {
  return parseDurationMs(containerSleepAfter(env));
}

export function warmPoolRefreshIntervalMs(env: ContainerPoolConfigEnv): number {
  return parsePositiveInteger(
    env.WARM_POOL_REFRESH_INTERVAL,
    DEFAULT_WARM_POOL_REFRESH_INTERVAL_MS,
  );
}

export function warmPoolTarget(env: ContainerPoolConfigEnv): number {
  return parsePositiveInteger(env.WARM_POOL_TARGET, DEFAULT_WARM_POOL_TARGET);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return 120_000;
  const amount = Number.parseInt(match[1] ?? "0", 10);
  switch (match[2] ?? "s") {
    case "ms":
      return amount;
    case "s":
      return amount * 1_000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 3_600_000;
    default:
      return 120_000;
  }
}
