import { createHash, randomBytes } from "node:crypto"

export const KEY_PREFIX_LENGTH = 12

/** `linq_` + 32 random bytes, base64url. Shown to the caller exactly once. */
export function generateKey(): string {
  return `linq_${randomBytes(32).toString("base64url")}`
}

/** SHA-256 hex of a key. This is what `api_keys.key_hash` holds; the secret never is. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

/** Stored alongside the hash so a key stays recognisable in lists. */
export function keyPrefix(key: string): string {
  return key.slice(0, KEY_PREFIX_LENGTH)
}
