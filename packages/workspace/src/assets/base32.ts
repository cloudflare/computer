// Crockford base32 encoding.
//
// Used to turn the 16 random bytes behind a UUID into a short,
// URL-safe token for asset keys: ~26 lowercase characters with no
// hyphens, versus the 36-char hyphenated UUID string.
//
// The alphabet is Crockford's: digits 0-9 then the consonants and
// vowels of the Latin alphabet with I, L, O, and U removed to avoid
// visual ambiguity. We emit lowercase. Decoding accepts either
// case and maps the ambiguous letters back (I/L → 1, O → 0) so a
// round trip survives a human transcribing the token.
//
// This is a plain big-endian base32: bytes are treated as one
// continuous bit string, most significant bit first, sliced into
// 5-bit groups. No checksum, no padding.

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

// Reverse lookup for decode. Built once. Includes the lowercase
// alphabet, its uppercase form, and the ambiguous-letter aliases.
const DECODE = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE.set(ALPHABET[i], i);
  DECODE.set(ALPHABET[i].toUpperCase(), i);
}
DECODE.set("o", 0);
DECODE.set("O", 0);
DECODE.set("i", 1);
DECODE.set("I", 1);
DECODE.set("l", 1);
DECODE.set("L", 1);

// Encode bytes as Crockford base32. The output length is
// ceil(bytes.length * 8 / 5) characters.
export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

// Decode a Crockford base32 string back to bytes. Throws on any
// character outside the alphabet (after alias folding). The number
// of bytes recovered is floor(input.length * 5 / 8); trailing bits
// that don't fill a byte are discarded, matching the encoder's
// zero-padding of the final group.
export function decodeBase32(text: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const digit = DECODE.get(char);
    if (digit === undefined) {
      throw new Error(`decodeBase32: invalid character ${JSON.stringify(char)}`);
    }
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// Generate a short random id: 16 random bytes (a UUID's worth of
// entropy) Crockford base32-encoded into 26 lowercase characters.
export function randomId(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): string {
  return encodeBase32(randomBytes(16));
}

function defaultRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}
