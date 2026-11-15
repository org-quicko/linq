import type { Condition } from "@linq/shared"
import { type Db, span } from "../libs/index.ts"
import { listRules } from "./RuleService.ts"

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

/**
 * A domain row may carry a port or not. The host is tried exactly as sent first,
 * then with its port stripped, so one `links.example.com` row also answers
 * requests on a non-standard port while `localhost:3000` still matches verbatim.
 */
function candidateHosts(hostHeader: string): string[] {
  const host = hostHeader.trim().toLowerCase()
  const bare = host.replace(/:\d+$/, "")
  return bare === host ? [host] : [host, bare]
}

export function findActiveDomain(db: Db, hostHeader: string): Promise<ResolvedDomain | null> {
  return span(
    "domain.findActive",
    async () => {
      const host = hostHeader.trim().toLowerCase()
      const rows = await db
        .selectFrom("domains")
        .select(["id", "host", "fallback_url", "base_path_redirect", "invalid_short_url_redirect"])
        .where("host", "in", candidateHosts(hostHeader))
        .where("status", "=", "active")
        .execute()

      const row = rows.find((r) => r.host === host) ?? rows[0]
      return row
        ? {
            id: row.id,
            fallback_url: row.fallback_url,
            base_path_redirect: row.base_path_redirect,
            invalid_short_url_redirect: row.invalid_short_url_redirect,
          }
        : null
    },
    { in: { host: hostHeader }, out: (domain) => ({ domain_id: domain?.id ?? null }) },
  )
}

/**
 * Whether this host was ever registered as a domain at all, active or
 * archived. Used only to decide the root path's admin-UI fallback, which must
 * fire for a host nobody registered but never for an archived one — that stays
 * a 404 for everything, root path included, same as `findActiveDomain` already
 * guarantees for a slug. Deliberately uncached and only ever queried once
 * `findActiveDomain` has already missed, since it exists purely to cover the
 * rare "unclaimed root path" case, not the hot redirect path.
 */
export function hostHasAnyDomain(db: Db, hostHeader: string): Promise<boolean> {
  return span(
    "domain.hostHasAny",
    async () => {
      const rows = await db
        .selectFrom("domains")
        .select("id")
        .where("host", "in", candidateHosts(hostHeader))
        .limit(1)
        .execute()
      return rows.length > 0
    },
    { in: { host: hostHeader } },
  )
}

/**
 * Looks up what a slug resolves to on one domain, rules included. Archived links
 * are invisible here.
 */
export function findActiveTarget(
  db: Db,
  domainId: string,
  slug: string,
): Promise<ResolvedTarget | null> {
  return span(
    "link.findActive",
    async () => {
      const row = await db
        .selectFrom("links")
        .selectAll()
        .where("domain_id", "=", domainId)
        .where("slug", "=", slug)
        .where("status", "=", "active")
        .limit(1)
        .executeTakeFirst()
      if (!row) return null
      // Rules ride inside the same entry: every hit that resolves reads them, so
      // caching the link without them would leave a query behind on the hot path.
      const rules = await listRules(db, row.id)
      return {
        link_id: row.id,
        name: row.name,
        destination: row.destination,
        forward_query: row.forward_query,
        preset_params: row.preset_params,
        rules: rules.map((rule) => ({
          destination: rule.destination,
          conditions: rule.conditions,
        })),
        expires_at: row.expires_at?.getTime() ?? null,
      }
    },
    { in: { domain_id: domainId, slug }, out: (target) => ({ link_id: target?.link_id ?? null }) },
  )
}

/**
 * The given parameters win per key, and repeats survive: every key in
 * `overrides` replaces the destination's copy of that key entirely.
 */
export function mergeQuery(destination: string, overrides: URLSearchParams): string {
  const url = new URL(destination)
  for (const key of new Set(overrides.keys())) url.searchParams.delete(key)
  for (const [key, value] of overrides) url.searchParams.append(key, value)
  return url.toString()
}

/** The visit's record of what the caller asked for, before any merging. */
export function toQueryParams(params: URLSearchParams): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const [key, value] of params) {
    const seen = out[key]
    if (seen) seen.push(value)
    else out[key] = [value]
  }
  return Object.keys(out).length ? out : null
}
