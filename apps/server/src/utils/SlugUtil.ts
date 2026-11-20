import { randomInt } from "node:crypto"
import { RESERVED_SLUGS } from "@linq/shared"

/** Slug generation and reservation checks. */
export class SlugUtil {
  /**
   * A random base62 slug. Uniform: `randomInt` rejects biased samples, which a
   * plain `randomBytes` modulo would not.
   *
   * @param length - How many characters (LINQ_SLUG_LENGTH).
   * @returns The slug. It may be reserved or taken; the caller checks both.
   */
  static generateSlug(length: number): string {
    const alphabet = SlugUtil.SLUG_ALPHABET
    return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("")
  }

  /**
   * Static server paths plus the top-level slug the Client UI mount claims. A
   * root mount claims no slug: it only ever answers on LINQ_APP_HOST, never on a
   * shortening domain.
   *
   * @param slug - The slug to check, in any case.
   * @param clientBasePath - LINQ_CLIENT_BASE_PATH.
   * @returns True when the slug may not be used for a link.
   */
  static isReservedSlug(slug: string, clientBasePath: string): boolean {
    const normalised = slug.toLowerCase()
    const segment = clientBasePath.slice(1).split("/")[0] ?? ""
    return RESERVED_SLUGS.has(normalised) || (segment !== "" && normalised === segment)
  }

  /** base62. Reserved slugs and the accepted shape live in @linq/shared. */
  private static readonly SLUG_ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
}
