const encoder = new TextEncoder();

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
  const totalBytes = encoder.encode(value).byteLength;
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
  for (const char of value) {
    const charBytes = encoder.encode(char).byteLength;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    end += char.length;
  }
  return { text: value.slice(0, end), bytes };
}
