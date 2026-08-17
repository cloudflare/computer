// Shared secret authorizing the host's requests to the container's HTTP
// surface.
//
// It has to be durable rather than generated per call. A durable object
// can be reconstructed while its container keeps running, and in that
// case start() does not relaunch, so the environment the container holds
// is the one from the original launch. A fresh secret each incarnation
// would not match it and every request would be refused, breaking the
// reconnect that POST /connect exists to serve.
//
// Persisting it also covers the other direction: when a replacement
// container is launched, it receives the value already stored, so both
// ends stay in step without the host having to read anything back.

interface ClientSecretStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const STORAGE_KEY = "computer:container-client-secret";

// 16 random bytes, hex encoded: 32 characters carrying 128 bits.
const SECRET_BYTES = 16;

function generate(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ContainerClientSecret {
  constructor(private readonly storage: ClientSecretStorage) {}

  // Returns the stored secret, generating and persisting one the first
  // time. Callers may invoke this on every start; only the first writes.
  async ensure(): Promise<string> {
    const existing = await this.storage.get<string>(STORAGE_KEY);
    if (typeof existing === "string" && existing.length > 0) return existing;
    const secret = generate();
    await this.storage.put(STORAGE_KEY, secret);
    return secret;
  }
}
