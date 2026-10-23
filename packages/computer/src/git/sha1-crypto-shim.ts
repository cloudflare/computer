// sha.js/sha1.js compatibility layer backed by `node:crypto`.
//
// isomorphic-git imports sha.js's SHA-1 class for two things: the
// synchronous fallback `new Hash().update(buffer).digest("hex")` when
// crypto.subtle has no SHA-1, and the streaming hash `_pack` feeds
// with `update(chunk)` before reading the raw `digest()`. Workers
// provide native SHA-1 through nodejs_compat, so the package build
// aliases `sha.js/sha1.js` here instead of bundling sha.js and the
// Buffer, safe-buffer and typed-array polyfills it pulls in.

import { createHash, type BinaryLike, type BinaryToTextEncoding, type Hash } from "node:crypto";

export default class Sha1 {
  readonly #hash: Hash = createHash("sha1");

  update(data: BinaryLike): this {
    this.#hash.update(data);
    return this;
  }

  digest(): Buffer;
  digest(encoding: BinaryToTextEncoding): string;
  digest(encoding?: BinaryToTextEncoding): Buffer | string {
    return encoding === undefined ? this.#hash.digest() : this.#hash.digest(encoding);
  }
}
