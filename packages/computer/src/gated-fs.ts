/**
 * A `WorkspaceFilesystem` whose mutating methods go through a gate.
 *
 * `Workspace.fs` hands callers a filesystem handle that writes to the
 * local store directly, without crossing the wire. That makes it the
 * other way into the workspace besides `shell.exec`, and a gate that
 * only covered exec would be trivial to walk around — deny the
 * command, write the file yourself. Gating both closes that.
 *
 * A subclass rather than a wrapper object, so the handle stays a
 * `WorkspaceFilesystem` for every caller that already has one and for
 * the mount and think surfaces that take one by type. Reads are not
 * overridden and cost nothing.
 *
 * Each mutation is gated on its own. That is safe here in a way it is
 * not for a shell command: one `writeFile` is the entire action, so
 * refusing it leaves nothing half-finished. See the note in `./gate.ts`
 * for why a command is gated once instead.
 */

import type { Database } from "@cloudflare/dofs";
import {
  type MkdirOptions,
  type RmOptions,
  WorkspaceFilesystem,
  type WorkspaceFilesystemOptions,
  type WriteFileContent,
  type WriteFileOptions,
} from "@cloudflare/dofs";

import { type WorkspaceAudit, type WorkspaceGate, withGate } from "./gate.js";

export interface GatedFilesystemOptions extends WorkspaceFilesystemOptions {
  gate: WorkspaceGate;
  audit: WorkspaceAudit;
}

export class GatedWorkspaceFilesystem extends WorkspaceFilesystem {
  readonly #gate: WorkspaceGate;
  readonly #audit: WorkspaceAudit;

  constructor(db: Database, options: GatedFilesystemOptions) {
    super(db, options);
    this.#gate = options.gate;
    this.#audit = options.audit;
  }

  override async writeFile(
    path: string,
    content: WriteFileContent,
    options: WriteFileOptions = {},
  ): Promise<void> {
    // Only reported when it is already known. Measuring a stream to
    // fill in the field would consume it.
    const size = byteLength(content);
    return withGate(this.#gate, this.#audit, { kind: "fs.write", path, size }, () =>
      super.writeFile(path, content, options),
    );
  }

  override async mkdir(path: string, options: MkdirOptions = {}): Promise<void> {
    return withGate(this.#gate, this.#audit, { kind: "fs.mkdir", path }, () =>
      super.mkdir(path, options),
    );
  }

  override async rm(path: string, options: RmOptions = {}): Promise<void> {
    // One gate call for the whole tree when recursive. The gate sees
    // the path the caller named, which is the decision it can
    // actually make; asking per descendant would raise the same
    // half-deleted-tree problem that shell commands have.
    return withGate(this.#gate, this.#audit, { kind: "fs.rm", path }, () =>
      super.rm(path, options),
    );
  }

  override async chmod(path: string, mode: number): Promise<void> {
    return withGate(this.#gate, this.#audit, { kind: "fs.chmod", path }, () =>
      super.chmod(path, mode),
    );
  }

  override async symlink(target: string, path: string): Promise<void> {
    // Gated on the link's own path, not the target. Creating a link
    // writes at `path`; the target may not exist and is allowed to
    // dangle, so it is not the thing being modified.
    return withGate(this.#gate, this.#audit, { kind: "fs.symlink", path }, () =>
      super.symlink(target, path),
    );
  }
}

// A stream has no length until it is read, and reading it here would
// consume the bytes the write needs. Those calls reach the gate with
// `size` absent rather than with a wrong number.
function byteLength(content: WriteFileContent): number | undefined {
  if (typeof content === "string") return new TextEncoder().encode(content).byteLength;
  if (content instanceof Uint8Array) return content.byteLength;
  return undefined;
}
