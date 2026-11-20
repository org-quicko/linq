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
  name: string | null
  destination: string
  forward_query: boolean
  preset_params: Record<string, string>
  rules: { destination: string; conditions: Condition[] }[]
  /**
   * Epoch milliseconds, not a Date and not an ISO string: this object is
   * JSON-round-tripped by the Redis backend and stored by reference by the memory
   * one, and a number is the only shape that survives both identically. Null means
   * the link never expires.
   */
  expires_at: number | null
}
