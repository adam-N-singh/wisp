// RFC 4648 base32, lowercase, unpadded: each client persistence file is named
// `<base32(utf8 key)>.blob`, which keeps arbitrary keys filesystem-safe and
// case-insensitive.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): string | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of encoded) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(out));
  } catch {
    return null;
  }
}
