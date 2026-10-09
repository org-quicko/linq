import { type Kysely, sql } from "kysely"

/**
 * Documents every table, and every column whose meaning is not obvious from
 * its name, as PostgreSQL comments. They live in the catalog, so `pg_dump`
 * writes them into resources/sql/schema.sql and database tools show them.
 * A later migration that changes a column's meaning updates its comment too.
 *
 * Comments only: no data or structure changes. One statement per entry,
 * because PGlite rejects multi-statement queries.
 */
const comments: [target: string, text: string][] = [
  // Types
  [
    "TYPE resource_status",
    "active, or archived: soft-deleted, keeping its rows and, for a link, its slug.",
  ],
  [
    "TYPE platform",
    "The routing value Rules match on. desktop is also the fallback for an unknown or absent user agent.",
  ],
  [
    "TYPE visit_dimension",
    "A visit_days grouping. total counts every visit of the day and is what the day grouping reads.",
  ],
  [
    "TYPE bot_classification",
    "Why ingest classified a visit as a bot, or unknown for one it did not.",
  ],

  // api_keys
  [
    "TABLE api_keys",
    "The principal. There are no user rows: a key carries its own name and claims, so authentication is one row and no join (resources/docs/adr/0011, 0017). Revoking a key deletes the row. Links carry no reference to the key that created them, so revoking never touches them (resources/docs/adr/0016).",
  ],
  ["COLUMN api_keys.name", "Who or what the key is for."],
  [
    "COLUMN api_keys.claims",
    "CASL action/subject rules the key is allowed, evaluated on every request (resources/docs/adr/0017).",
  ],
  [
    "COLUMN api_keys.key_hash",
    "sha256 of the secret. The secret itself is shown once and never stored.",
  ],
  ["COLUMN api_keys.prefix", "First characters of the key, so it is recognisable in a list."],
  ["COLUMN api_keys.expires_at", "Null never expires."],

  // domains
  [
    "TABLE domains",
    "A host that serves short links, with what to do when a request matches no link.",
  ],
  ["COLUMN domains.host", "Lowercased, optionally carrying a port."],
  ["COLUMN domains.fallback_url", "Where an unmatched but well-formed slug goes. Null means 404."],
  [
    "COLUMN domains.base_path_redirect",
    "Where a bare GET / (empty slug) goes. Null falls back to fallback_url, then 404.",
  ],
  [
    "COLUMN domains.invalid_short_url_redirect",
    "Where a malformed (not just unknown) slug goes. Null falls back to fallback_url, then 404.",
  ],

  // links
  [
    "TABLE links",
    "One short link: a slug on a domain. Archiving keeps the row so a dead link cannot be hijacked by a new one; only a purge releases the slug (resources/docs/adr/0002).",
  ],
  [
    "COLUMN links.domain_id",
    "Immutable. ON DELETE RESTRICT: a domain cannot be purged while any link row points at it.",
  ],
  ["COLUMN links.slug", "Immutable, and never released except by a purge."],
  [
    "COLUMN links.description",
    "Filled from the destination's <head> when the request did not supply one (resources/docs/adr/0014).",
  ],
  [
    "COLUMN links.icon_url",
    "The destination's favicon, resolved to an absolute URL (resources/docs/adr/0014).",
  ],
  ["COLUMN links.forward_query", "Merge the incoming query string over the destination."],
  [
    "COLUMN links.preset_params",
    "Record<string, string>, at most 20. Set on the destination when forward_query is true, overriding its own query and the forwarded one.",
  ],
  [
    "COLUMN links.expires_at",
    "Past this, the link resolves like an unknown slug. Null never expires.",
  ],
  [
    "COLUMN links.listed",
    "Opt-in: listed in the domain's public /llms.txt catalogue (resources/docs/adr/0013).",
  ],

  // rules
  [
    "TABLE rules",
    "Ordered alternate destinations for a link, at most 50. The lowest matching position wins.",
  ],
  ["COLUMN rules.position", "Server-owned, gapless from 0."],
  [
    "COLUMN rules.conditions",
    "Condition[]: platform | query_param. ANDed, never empty, at most 10.",
  ],

  // tags
  [
    "TABLE tags",
    "Every tag name ever attached to a link. A tag no link carries any more stays here but drops out of GET /v1/tags, which counts through link_tags (resources/docs/adr/0020).",
  ],
  ["COLUMN tags.name", "Lowercased and trimmed by the API, at most 50 characters."],
  [
    "TABLE link_tags",
    "A link carries a tag. At most 20 per link. Unordered: the API returns a link's tags sorted by name.",
  ],

  // qr_codes
  [
    "TABLE qr_codes",
    "A styled QR code for a link. The encoded data is never stored: it is always the link's current short URL, resolved at render time, so only the styling lives here. Deleted, not archived (resources/docs/adr/0002).",
  ],

  // visits
  [
    "TABLE visits",
    "One row per request, inserted fire-and-forget so a visit never delays a redirect. The only source of truth for analytics: visit_days and visit_counts are derived from it by trigger (resources/docs/adr/0007).",
  ],
  ["COLUMN visits.id", "UUIDv7, so it breaks ties in the order visits happened."],
  [
    "COLUMN visits.link_id",
    "Null is an orphan visit. ON DELETE CASCADE, so purging a link destroys its visits.",
  ],
  ["COLUMN visits.slug_requested", "What the caller asked for. Empty for the root path."],
  ["COLUMN visits.is_bot", "Decided once at ingest. No user agent at all counts as a bot."],
  [
    "COLUMN visits.bot_classification",
    "Why is_bot was decided. Null on visits recorded before it existed, or imported without one.",
  ],
  [
    "COLUMN visits.os",
    "Open vocabulary (unlike platform), lowercased. Null when it could not be determined.",
  ],
  [
    "COLUMN visits.browser",
    "Open vocabulary (unlike platform), lowercased. Null when it could not be determined.",
  ],
  [
    "COLUMN visits.referer_host",
    "Generated: the host of referer. Empty for an absent or relative URL (resources/docs/adr/0015).",
  ],
  ["COLUMN visits.destination", "The URL actually chosen, after rules, before query merging."],
  ["COLUMN visits.query", "Record<string, string[]> of the incoming query, before any merging."],
  ...["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map(
    (k): [string, string] => [
      `COLUMN visits.${k}`,
      "Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.",
    ],
  ),
  [
    "COLUMN visits.device_type",
    "Generated from user_agent: mobile, tablet or desktop. Null when the user agent is absent or blank.",
  ],
  [
    "COLUMN visits.country",
    "ISO 3166-1 alpha-2. Only imported data fills it; linq does not capture it yet (resources/docs/adr/0021).",
  ],
  [
    "COLUMN visits.region",
    "Region name. Only imported data fills it; linq does not capture it yet (resources/docs/adr/0021).",
  ],

  // visit_days
  [
    "TABLE visit_days",
    "Pre-counted visits: one row per day, scope, dimension value and bot flag, serving every grouping the stats API offers (resources/docs/adr/0007). Derived: only the visits_rollup trigger writes here, thirteen rows per visit. link_id deliberately has no foreign key: purging a link merges its rows into the orphan scope, which ON DELETE SET NULL would pre-empt and collide on the unique key. domain_id cascades, so purging a domain destroys its rollups with its visits.",
  ],
  ["COLUMN visit_days.day", "Cut in UTC, so a report never shifts with the session timezone."],
  ["COLUMN visit_days.link_id", "Null is the orphan scope. No foreign key; see the table comment."],
  [
    "COLUMN visit_days.value",
    "Empty string where the dimension was not recorded, never a word a real value could collide with. The referer dimension holds a host, not the full URL.",
  ],

  // visit_counts
  [
    "TABLE visit_counts",
    "All-time totals per scope: one row per link, plus one per domain for its orphans. What link lists and overview tiles read instead of aggregating visits. Derived, and link_id has no foreign key, for the same reasons as visit_days.",
  ],
  [
    "COLUMN visit_counts.link_id",
    "Null is the orphan scope, one row per domain. No foreign key; see visit_days.",
  ],
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [target, text] of comments)
    await sql.raw(`COMMENT ON ${target} IS '${text.replaceAll("'", "''")}'`).execute(db)
}
