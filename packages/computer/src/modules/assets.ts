import { parseDuration } from "../artifacts/duration.js";
import type { ShareOptions } from "../assets/index.js";
import type {
  WorkspaceModuleFactory,
  WorkspaceModuleFunctions,
  WorkspaceModuleHost,
  WorkspaceRuntimeValue,
} from "../runtime/types.js";

export interface AssetsModuleOptions {
  readonly defaultExpiresAfterMs?: number;
}

const DEFAULT_EXPIRES_AFTER_MS = 60 * 60 * 1000;
const PUBLISH_OPTION_KEYS = new Set(["expiresAfter", "filename", "disposition", "contentType"]);

export function createAssetsModule(options: AssetsModuleOptions = {}): WorkspaceModuleFactory {
  const defaultExpiresAfter = options.defaultExpiresAfterMs ?? DEFAULT_EXPIRES_AFTER_MS;
  if (!Number.isFinite(defaultExpiresAfter) || defaultExpiresAfter <= 0) {
    throw new Error("createAssetsModule: defaultExpiresAfterMs must be a positive number.");
  }

  const create = (host: WorkspaceModuleHost): WorkspaceModuleFunctions => {
    const assets = host.assets;
    if (assets === undefined) {
      throw new Error(
        "ws:assets: the Workspace has no assets client. Pass `assets` to the Workspace.",
      );
    }
    return {
      async publish(args, context) {
        if (args.length === 0 || args.length > 2) {
          throw new TypeError(
            "publish(path, options?) takes a path and an optional options object.",
          );
        }
        const [path, publishOptions] = args;
        if (typeof path !== "string" || path.length === 0) {
          throw new TypeError("publish: path must be a non-empty string.");
        }
        const share = parsePublishOptions(publishOptions, defaultExpiresAfter);
        const resolved = await context.resolvePath(path);
        context.signal.throwIfAborted();
        return assets.share(resolved, share);
      },
    };
  };
  return Object.assign(create, {
    description:
      '`publish(path, { expiresAfter?, filename?, disposition?, contentType? })` uploads a workspace file and returns a time-limited public URL. `expiresAfter` is milliseconds or a duration like "30m" or "1d"; the default is one hour and the maximum is seven days. `disposition` is "inline" or "attachment".',
  });
}

function parsePublishOptions(
  value: WorkspaceRuntimeValue | undefined,
  defaultExpiresAfter: number,
): ShareOptions {
  if (value === undefined || value === null) return { expiresAfter: defaultExpiresAfter };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("publish: options must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!PUBLISH_OPTION_KEYS.has(key)) {
      throw new TypeError(
        `publish: unknown option ${JSON.stringify(key)}. Use expiresAfter, filename, disposition, or contentType.`,
      );
    }
  }
  const share: ShareOptions = {
    expiresAfter: parseExpiresAfter(value.expiresAfter, defaultExpiresAfter),
  };
  const filename = optionalString(value.filename, "filename");
  if (filename !== undefined) share.filename = filename;
  const contentType = optionalString(value.contentType, "contentType");
  if (contentType !== undefined) share.contentType = contentType;
  const disposition = value.disposition;
  if (disposition !== undefined && disposition !== null) {
    if (disposition !== "inline" && disposition !== "attachment") {
      throw new TypeError('publish: disposition must be "inline" or "attachment".');
    }
    share.disposition = disposition;
  }
  return share;
}

function parseExpiresAfter(value: WorkspaceRuntimeValue | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError("publish: expiresAfter must be a positive number of milliseconds.");
    }
    return value;
  }
  if (typeof value === "string") {
    try {
      return parseDuration(value) * 1000;
    } catch (error) {
      throw new TypeError(
        `publish: expiresAfter ${JSON.stringify(value)} is not a duration like "30m": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new TypeError("publish: expiresAfter must be a number of milliseconds or a duration.");
}

function optionalString(value: WorkspaceRuntimeValue | undefined, name: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`publish: ${name} must be a string.`);
  return value;
}
