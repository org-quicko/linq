import { createHash } from "node:crypto"

/** Hashing of API key secrets. */
export class HashUtil {
  /**
   * SHA-256 hex of a key. This is what `api_keys.key_hash` holds; the secret never is.
   *
   * @param key - The plaintext secret.
   * @returns Its hex digest.
   */
  static hashKey(key: string): string {
    return createHash("sha256").update(key).digest("hex")
  }
}
