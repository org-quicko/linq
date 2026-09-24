import { randomInt } from "node:crypto"

/** base62. Reserved slugs and the accepted shape live in @linq/shared. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/**
 * Uniform over the alphabet: `randomInt` rejects biased samples, which a plain
 * `randomBytes` modulo would not.
 */
export function randomSlug(length: number): string {
  let out = ""
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}
