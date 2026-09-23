// What the running container process was launched with.
//
// Some startup options cannot be changed once a container is running.
// A durable object that finds one already running therefore cannot
// apply them, and until it can tell what the container was launched
// with it has no way to know whether adopting it is safe. A warm pool
// that pre-starts containers is the case in point: the workspace that
// later adopts one may want a different environment, a different size,
// or no internet access at all.
//
// So each launch records what it used, and adoption compares. A
// container launched outside this API leaves no record at all, which
// reads as a mismatch and gets it relaunched rather than trusted.

/** Instance size accepted by `start()`, as the platform declares it. */
export type ContainerInstanceSize = NonNullable<ContainerStartupOptions["instance"]>;

// Everything the platform accepts at startup, minus the three fields
// this package owns. `env` and `enableInternet` are required rather
// than optional because every launch sets them. `image` is excluded
// deliberately: the platform makes it mutually exclusive with
// `containerSnapshot`, and the caller names an image through `name`
// instead, which the host resolves against ctx.container.images.
export interface ContainerLaunchSpec
  extends Omit<ContainerStartupOptions, "env" | "image" | "enableInternet"> {
  env: Record<string, string>;
  enableInternet: boolean;
  /** Key into `ctx.container.images`, resolved by the container host. */
  name?: string;
}

export interface ContainerLaunchRecord {
  enableInternet: boolean;
  // A digest rather than the environment itself: containerEnv is
  // consumer-supplied and may carry their own secrets, and this record
  // only ever needs to answer "the same or not".
  envDigest: string;
  // Canonicalised rather than stored raw, because a named tier and an
  // equivalent custom size are different shapes, and two custom sizes
  // written in a different key order are the same launch.
  instanceDigest?: string;
  name?: string;
  // A startup option that cannot change on a running container belongs
  // here too. hardTimeout is the next candidate, but the workers-types
  // this package compiles against does not declare it, so there is
  // nothing to digest yet; add it with the field rather than ahead of
  // it.
}

interface LaunchRecordStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const STORAGE_KEY = "computer:container-launch-record";

export async function launchRecordFor(spec: ContainerLaunchSpec): Promise<ContainerLaunchRecord> {
  // The field list is explicit rather than "digest the whole spec" so
  // that a startup option added upstream is a deliberate decision here
  // rather than an accidental relaunch trigger. The test file records
  // which side of the line each field falls on and why.
  return {
    enableInternet: spec.enableInternet,
    envDigest: await digestEnv(spec.env),
    ...(spec.instance === undefined ? {} : { instanceDigest: canonicalInstance(spec.instance) }),
    ...(spec.name === undefined ? {} : { name: spec.name }),
  };
}

export function sameLaunch(a: ContainerLaunchRecord, b: ContainerLaunchRecord): boolean {
  return (
    a.enableInternet === b.enableInternet &&
    a.envDigest === b.envDigest &&
    a.instanceDigest === b.instanceDigest &&
    a.name === b.name
  );
}

// A named tier is its own name; a custom size is its three numbers in a
// fixed order, tagged so no tier name could ever collide with one.
function canonicalInstance(instance: ContainerInstanceSize): string {
  if (typeof instance === "string") return `tier:${instance}`;
  return `size:${instance.vcpu}/${instance.memoryMib}/${instance.diskMb}`;
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
