/** base62, the same alphabet the server's `randomSlug` draws from. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export const SLUG_LENGTH = 6

/** Uniform over the alphabet: bytes >= 248 are dropped, since 256 % 62 would bias the rest. */
export function randomSlug(length = SLUG_LENGTH): string {
  let out = ""
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length)))
      if (byte < 248 && out.length < length) out += ALPHABET[byte % ALPHABET.length]
  }
  return out
}
