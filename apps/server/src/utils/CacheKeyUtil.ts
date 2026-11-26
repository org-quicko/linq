/** Cache key builders: every key linq reads or clears, in one place. */
export class CacheKeyUtil {
  /**
   * The domain a host resolves to. Keyed on the host exactly as the request sent
   * it, lowercased, because `findActiveDomain` prefers an exact match over the
   * port-stripped one and the two can be different rows.
   *
   * A domain row without a port that answered a request *with* one is cached under
   * a key no mutation can compute, so that variant is cleared by the TTL rather
   * than by an invalidation. Every host linq is actually configured for clears
   * immediately.
   *
   * @param host - The request's Host header.
   * @returns The cache key.
   */
  static domainKey(host: string): string {
    return `domain:${host.trim().toLowerCase()}`
  }

  /**
   * The whole redirect answer for one slug on one domain: link, rules and all.
   *
   * @param domainId - The domain's id.
   * @param slug - The slug, as requested.
   * @returns The cache key.
   */
  static targetKey(domainId: string, slug: string): string {
    return `target:${domainId}:${slug}`
  }

  /**
   * The whole rendered /llms.txt for one domain. A string round-trips through
   * both backends unchanged, so unlike a row array it needs no date handling.
   *
   * @param domainId - The domain's id.
   * @returns The cache key.
   */
  static llmsKey(domainId: string): string {
    return `llms:${domainId}`
  }

  /**
   * Everything a link mutation makes stale: its redirect entry and its domain's
   * published catalogue. One call, so a new mutation cannot forget half of it.
   *
   * @param domainId - The link's domain id.
   * @param slug - The link's slug.
   * @returns The cache keys to delete.
   */
  static linkKeys(domainId: string, slug: string): string[] {
    return [CacheKeyUtil.targetKey(domainId, slug), CacheKeyUtil.llmsKey(domainId)]
  }
}
