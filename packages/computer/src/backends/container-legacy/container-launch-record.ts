// What the running container process was launched with.
//
// The environment and the outbound-internet flag can only be set when
// the process starts. A durable object that finds a container already
// running therefore cannot apply either one, and until it can tell what
// the container was launched with it has no way to know whether adopting
// it is safe. A warm pool that pre-starts containers is the case in
// point: the workspace that later adopts one may want a different
// environment, or no internet access at all.
//
// So each launch records what it used, and adoption compares. A
// container launched outside this API leaves no record at all, which
// reads as a mismatch and gets it relaunched rather than trusted.

export interface ContainerLaunchSpec {
  // Environment for the container image. The launch adds
  // RPC_CLIENT_SECRET on top, so no caller needs to know it exists and
  // it stays out of the digest below.
  env: Record<string, string>;
  // Platform switch for outbound internet. Cannot be changed on a live
  // container, which is why a mismatch has to relaunch.
  enableInternet: boolean;
}

export interface ContainerLaunchRecord {
  enableInternet: boolean;
  // A digest rather than the environment itself: containerEnv is
  // consumer-supplied and may carry their own secrets, and this record
  // only ever needs to answer "the same or not".
  envDigest: string;
}

interface LaunchRecordStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const STORAGE_KEY = "computer:container-launch-record";

export async function launchRecordFor(spec: ContainerLaunchSpec): Promise<ContainerLaunchRecord> {
  return { enableInternet: spec.enableInternet, envDigest: await digestEnv(spec.env) };
}

export function sameLaunch(a: ContainerLaunchRecord, b: ContainerLaunchRecord): boolean {
  return a.enableInternet === b.enableInternet && a.envDigest === b.envDigest;
}

// Sorted so two callers building the same environment in a different
// order agree, and length-prefixed so no combination of names and
// values can be rearranged into the same input.
async function digestEnv(env: Record<string, string>): Promise<string> {
  const canonical = Object.keys(env)
    .sort()
    .map((name) => `${name.length}:${name}=${env[name]?.length ?? 0}:${env[name] ?? ""}`)
    .join(";");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CurrentContainerLaunchRecord {
  constructor(private readonly storage: LaunchRecordStorage) {}

  async get(): Promise<ContainerLaunchRecord | null> {
    return (await this.storage.get<ContainerLaunchRecord>(STORAGE_KEY)) ?? null;
  }

  async set(record: ContainerLaunchRecord): Promise<void> {
    await this.storage.put(STORAGE_KEY, record);
  }
}
