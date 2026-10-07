/**
 * Cut text to at most `maxBytes` UTF-8 bytes without splitting a
 * character, and say how much was left out.
 *
 * @param value - The text to cut.
 * @param maxBytes - The largest number of UTF-8 bytes to keep.
 * @returns The text unchanged when it fits, or its longest whole-character
 *   prefix followed by a `[truncated, N more bytes]` marker.
 */
export function truncateText(value: string, maxBytes: number): string {
  const totalBytes = utf8ByteLength(value);
  if (totalBytes <= maxBytes) return value;
  const { text, bytes } = utf8Prefix(value, maxBytes);
  return `${text}\n\n[truncated, ${totalBytes - bytes} more bytes]`;
}

/**
 * The longest whole-character prefix of `value` that fits in `maxBytes`
 * UTF-8 bytes.
 *
 * @param value - The text to cut.
 * @param maxBytes - The largest number of UTF-8 bytes to keep.
 * @returns The prefix and its size in bytes.
 */
export function utf8Prefix(value: string, maxBytes: number): { text: string; bytes: number } {
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const width = surrogatePairAt(value, end) ? 2 : 1;
    const charBytes = width === 2 ? 4 : utf8UnitBytes(value.charCodeAt(end));
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += width;
  }
  return { text: value.slice(0, end), bytes };
}

/**
 * The size of `value` in UTF-8 bytes, the same as
 * `new TextEncoder().encode(value).byteLength`, counted without making
 * an encoded copy of the string.
 *
 * @param value - The text to measure.
 * @returns Its UTF-8 size in bytes. A lone surrogate counts as the
 *   three bytes of the replacement character it encodes to.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (surrogatePairAt(value, index)) {
      bytes += 4;
      index += 1;
    } else {
      bytes += utf8UnitBytes(value.charCodeAt(index));
    }
  }
  return bytes;
}

// UTF-8 bytes for one UTF-16 code unit that is not half of a pair. A
// lone surrogate encodes as U+FFFD, which takes three bytes.
function utf8UnitBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

function surrogatePairAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  if (code < 0xd800 || code > 0xdbff) return false;
  const next = value.charCodeAt(index + 1);
  return next >= 0xdc00 && next <= 0xdfff;
}
