import type { Condition } from "@linq/shared"
import type { Versioned } from "../infra/cache.ts"
import type { Db } from "../infra/db/client.ts"
import { span } from "../infra/log.ts"
import { listRules } from "../rules/store.ts"

/**
 * What the redirect caches, built the same way whether a request missed the
 * cache or a write is updating it, so the two can never disagree on an
 * entry's value or its version. See resources/docs/adr/0024.
 */

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
   * JSON-round-tripped through Redis, and a number is the only shape that
   * survives it unchanged. Null means the link never expires.
   */
  expires_at: number | null
}

/**
 * A domain row may carry a port or not. The host is tried exactly as sent first,
 * then with its port stripped, so one `links.example.com` row also answers
 * requests on a non-standard port while `localhost:3000` still matches verbatim.
 */
export function candidateHosts(hostHeader: string): string[] {
  const host = hostHeader.trim().toLowerCase()
  const bare = host.replace(/:\d+$/, "")
  return bare === host ? [host] : [host, bare]
}

/**
 * The active domain a host resolves to. Archived rows are read too, for the
 * version only: it is the newest `updated_at` among every row the host could
 * match, so archiving, restoring or editing any of them moves it forward.
 */
export function loadDomain(db: Db, hostHeader: string): Promise<Versioned<ResolvedDomain | null>> {
  return span(
    "domain.findActive",
    async () => {
      const host = hostHeader.trim().toLowerCase()
      const rows = await db
        .selectFrom("domains")
        .select([
          "id",
          "host",
          "status",
          "updated_at",
          "fallback_url",
          "base_path_redirect",
          "invalid_short_url_redirect",
        ])
        .where("host", "in", candidateHosts(hostHeader))
        .execute()

      const active = rows.filter((r) => r.status === "active")
      const row = active.find((r) => r.host === host) ?? active[0] ?? null
      return {
        value: row
          ? {
              id: row.id,
              fallback_url: row.fallback_url,
              base_path_redirect: row.base_path_redirect,
              invalid_short_url_redirect: row.invalid_short_url_redirect,
            }
          : null,
        version: Math.max(0, ...rows.map((r) => r.updated_at.getTime())),
      }
    },
    { in: { host: hostHeader }, out: (d) => ({ domain_id: d.value?.id ?? null }) },
  )
}

/**
 * What a slug resolves to on one domain, rules included. An archived link is
 * read for its version but resolves to null, so archiving writes a null that
 * outranks the live entry it replaces.
 */
export function loadTarget(
  db: Db,
  domain_id: string,
  slug: string,
): Promise<Versioned<ResolvedTarget | null>> {
  return span(
    "link.findActive",
    async () => {
      const row = await db
        .selectFrom("links")
        .selectAll()
        .where("domain_id", "=", domain_id)
        .where("slug", "=", slug)
        .limit(1)
        .executeTakeFirst()
      const version = row?.updated_at.getTime() ?? 0
      if (!row || row.status !== "active") return { value: null, version }
      // Rules ride inside the same entry: every hit that resolves reads them, so
      // caching the link without them would leave a query behind on the hot path.
      const ordered = await listRules(db, row.id)
      return {
        value: {
          link_id: row.id,
          name: row.name,
          destination: row.destination,
          forward_query: row.forward_query,
          preset_params: row.preset_params,
          rules: ordered.map((r) => ({ destination: r.destination, conditions: r.conditions })),
          expires_at: row.expires_at?.getTime() ?? null,
        },
        version,
      }
    },
    { in: { domain_id, slug }, out: (t) => ({ link_id: t.value?.link_id ?? null }) },
  )
}
