import type { LinkTreePage, LinkType } from "./LinkTreeType.ts"
import type { Condition } from "./RuleType.ts"

/** The part of a domain row the redirect needs. Null means no active domain. */
export type ResolvedDomain = {
  id: string
  fallback_url: string | null
  base_path_redirect: string | null
  invalid_short_url_redirect: string | null
}

/**
 * Everything one slug on one domain resolves to, rules included, so a cache hit
 * answers the whole redirect. Null means no active link, i.e. an orphan visit.
 * Field names mirror the columns, and must stay stable: entries outlive a deploy
 * in Redis.
 */
export type ResolvedTarget = {
  link_id: string
  /** Absent on an entry cached before Link Trees existed, which was a redirect. */
  type?: LinkType
  name: string | null
  /** Null for a Link Tree. */
  destination: string | null
  forward_query_params: boolean
  preset_params: Record<string, string>
  rules: { destination: string; conditions: Condition[] }[]
  /**
   * Epoch milliseconds, not a Date and not an ISO string: this object is
   * JSON-round-tripped by the Redis backend and stored by reference by the memory
   * one, and a number is the only shape that survives both identically. Null means
   * the link never expires.
   */
  expires_at: number | null
  /** The page a Link Tree serves; absent for a redirect Link. */
  tree?: ResolvedLinkTree
}

/**
 * A Link Tree page as the redirect caches it. Each Item keeps its target's
 * expiry, because an Item can lapse while the entry is still cached and no
 * mutation arrives to clear it.
 */
export type ResolvedLinkTree = Omit<LinkTreePage, "items"> & {
  items: { label: string; url: string; expires_at: number | null }[]
}
