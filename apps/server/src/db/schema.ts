import type { Condition } from "@linq/shared"
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const roleEnum = pgEnum("role", ["viewer", "editor", "admin"])
export const resourceStatusEnum = pgEnum("resource_status", ["active", "archived"])
export const platformEnum = pgEnum("platform", ["android", "ios", "desktop"])
export const qrPatternEnum = pgEnum("qr_pattern", ["squares", "rounded", "dots"])

const created_at = timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updated_at = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

/**
 * The principal. A key is the only thing that acts — there are no user rows, so
 * a key carries its own name and role. See docs/adr/0011.
 *
 * Only the sha256 of the secret is stored; `prefix` exists so a key is
 * recognisable in a list.
 */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  key_hash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  expires_at: timestamp("expires_at", { withTimezone: true }),
  created_at,
  updated_at,
})

export const domains = pgTable("domains", {
  id: uuid("id").primaryKey(),
  host: text("host").notNull().unique(),
  /** Where an unmatched-but-well-formed slug goes. Null means 404. This is
   *  the regular 404 case and by far the common one — see the other two
   *  redirect columns below for the other two cases the redirect handler
   *  distinguishes. */
  fallback_url: text("fallback_url"),
  /** Where a visitor lands on `GET /` (an empty slug). Null falls back to
   *  `fallback_url`, then 404. */
  base_path_redirect: text("base_path_redirect"),
  /** Where a visitor lands when the slug is malformed (fails `SLUG_PATTERN`)
   *  rather than simply unknown. Null falls back to `fallback_url`, then 404. */
  invalid_short_url_redirect: text("invalid_short_url_redirect"),
  status: resourceStatusEnum("status").notNull().default("active"),
  created_at,
  updated_at,
})

/**
 * A slug is unique per domain and is never released: archiving keeps the row so
 * a dead link cannot be hijacked by a new one. See docs/adr/0002.
 */
export const links = pgTable(
  "links",
  {
    id: uuid("id").primaryKey(),
    domain_id: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    destination: text("destination").notNull(),
    name: text("name"),
    /** Filled from the destination's <head> when the request didn't supply
     *  one. See docs/adr/0014. */
    description: text("description"),
    /** The destination's favicon, resolved to an absolute URL. Never
     *  caller-supplied — always whatever the last fetch found, or null.
     *  See docs/adr/0014. */
    icon_url: text("icon_url"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    forward_query: boolean("forward_query").notNull().default(true),
    preset_params: jsonb("preset_params").$type<Record<string, string>>().notNull().default({}),
    status: resourceStatusEnum("status").notNull().default("active"),
    /** Past this, the link resolves like an unknown slug. Null never expires. */
    expires_at: timestamp("expires_at", { withTimezone: true }),
    /** Opt-in: listed in this domain's public /llms.txt catalogue. Off by
     *  default, because listing publishes a link's slug, name and
     *  destination to anyone. */
    listed: boolean("listed").notNull().default(false),
    created_at,
    updated_at,
  },
  (t) => [
    uniqueIndex("links_domain_slug_key").on(t.domain_id, t.slug),
    index("links_status_idx").on(t.status),
    index("links_tags_idx").using("gin", t.tags),
    index("links_listed_idx").on(t.domain_id).where(sql`${t.listed}`),
  ],
)

/** Ordered alternate destinations. Lowest position that matches wins. */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey(),
    link_id: uuid("link_id")
      .notNull()
      .references(() => links.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    destination: text("destination").notNull(),
    conditions: jsonb("conditions").$type<Condition[]>().notNull(),
  },
  (t) => [uniqueIndex("rules_link_position_key").on(t.link_id, t.position)],
)

/**
 * A QR code for a short link. The encoded data is never stored — it is
 * always the link's current `shortUrl`, derived at request time, so renaming
 * a domain re-points every printed code. Only the styling lives here.
 * `ON DELETE CASCADE` is the whole enforcement of "a QR code is always
 * associated with a short link".
 */
export const qrCodes = pgTable(
  "qr_codes",
  {
    id: uuid("id").primaryKey(),
    link_id: uuid("link_id")
      .notNull()
      .references(() => links.id, { onDelete: "cascade" }),
    name: text("name"),
    dot_color: text("dot_color").notNull().default("#000000"),
    bg_color: text("bg_color").notNull().default("#ffffff"),
    pattern: qrPatternEnum("pattern").notNull().default("squares"),
    created_at,
    updated_at,
  },
  (t) => [index("qr_codes_link_id_idx").on(t.link_id)],
)

/** One row per request. `link_id` null means an orphan visit. */
export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey(),
    link_id: uuid("link_id").references(() => links.id, { onDelete: "cascade" }),
    domain_id: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    slug_requested: text("slug_requested").notNull(),
    occurred_at: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    is_bot: boolean("is_bot").notNull(),
    platform: platformEnum("platform").notNull(),
    os: text("os"),
    browser: text("browser"),
    user_agent: text("user_agent"),
    referer: text("referer"),
    /** The referer header's host, '' when absent — what the rollup and every
     *  referrer filter key on. A real stored column, not an index expression:
     *  Postgres will not serve an index-only scan out of an index
     *  expression, and this column exists to be in the covering index below.
     *  Generated rather than parsed at ingest so it cannot drift from the
     *  column it derives from, and so Postgres backfills existing rows
     *  itself. See docs/adr/0015. */
    referer_host: text("referer_host").generatedAlwaysAs(sql`referer_host("referer")`),
    destination: text("destination"),
    query: jsonb("query").$type<Record<string, string[]>>(),
  },
  (t) => [
    index("visits_link_occurred_idx").on(t.link_id, t.occurred_at.desc()),
    index("visits_domain_occurred_idx").on(t.domain_id, t.occurred_at.desc()),
    index("visits_orphan_occurred_idx").on(t.occurred_at.desc()).where(sql`${t.link_id} is null`),
    // Every column a filtered report reads, so the report can answer without
    // touching the base table. Measured: 312 buffers and zero heap fetches,
    // against 1,678 via a bitmap heap scan.
    // occurred_at leads because the window is the one predicate always
    // present. The rest are there for coverage — after a range qual on the
    // leading column their order barely matters, so they are narrowest-first.
    // `id` is deliberately NOT here.
    // `destination` is absent for the same reason: a full URL with query
    // string would roughly double the index to serve one breakdown, which
    // falls back to a heap scan.
    index("visits_analytics_idx").on(
      t.occurred_at.desc(),
      t.is_bot,
      t.platform,
      t.link_id,
      t.domain_id,
      t.os,
      t.browser,
      t.referer_host,
      t.slug_requested,
    ),
  ],
)

/**
 * What a day-wise rollup row counts. `total` is every visit of the day and is
 * what the `day` grouping reads; the rest mirror the groupings the stats API
 * offers. Keeping `total` explicit means no grouping is served by summing
 * another dimension and silently breaking when that one becomes optional.
 */
export const visitDimensionEnum = pgEnum("visit_dimension", [
  "total",
  "platform",
  "os",
  "browser",
  "referer",
  "destination",
  "slug",
])

/**
 * Pre-counted visits, one row per day, scope, dimension value and bot flag.
 * Derived data: only the triggers in `0005_visit_rollup_triggers.sql` write here,
 * and `visits` stays the source of truth. See docs/adr/0007.
 *
 * `link_id` carries no foreign key on purpose. A purge re-keys these rows to the
 * orphan scope by merging them, which an `ON DELETE SET NULL` would pre-empt and
 * collide on the unique constraint. `domain_id` does cascade, which is what makes
 * purging a domain destroy its rollups with its visits.
 */
export const visitDays = pgTable(
  "visit_days",
  {
    /** Cut in UTC, so a report never shifts with the database session timezone. */
    day: date("day", { mode: "string" }).notNull(),
    domain_id: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    link_id: uuid("link_id"),
    dimension: visitDimensionEnum("dimension").notNull(),
    /** Empty string where the dimension was not recorded, never a word a real value could collide with. */
    value: text("value").notNull(),
    is_bot: boolean("is_bot").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    // NULLS NOT DISTINCT, so the orphan scope upserts onto one row per key
    // instead of inserting a new one every time. Needs Postgres 15+.
    unique("visit_days_key")
      .on(t.day, t.domain_id, t.link_id, t.dimension, t.value, t.is_bot)
      .nullsNotDistinct(),
    index("visit_days_link_idx").on(t.link_id, t.dimension, t.day),
    index("visit_days_domain_idx").on(t.domain_id, t.dimension, t.day),
    // The unscoped report — the page everyone lands on — leads with neither
    // domain nor link, so neither index above can serve it.
    index("visit_days_dimension_day_idx").on(t.dimension, t.day),
  ],
)

/**
 * All-time totals per scope: one row per link, plus one per domain for its
 * orphans. What every link list and every overview tile reads instead of
 * aggregating the whole visits table. Derived data, like `visit_days`.
 */
export const visitCounts = pgTable(
  "visit_counts",
  {
    domain_id: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    link_id: uuid("link_id"),
    human: bigint("human", { mode: "number" }).notNull().default(0),
    bot: bigint("bot", { mode: "number" }).notNull().default(0),
    last_visit_at: timestamp("last_visit_at", { withTimezone: true }),
  },
  (t) => [
    unique("visit_counts_key").on(t.domain_id, t.link_id).nullsNotDistinct(),
    // The join every link response makes; the constraint above leads with the
    // domain and cannot serve it.
    index("visit_counts_link_idx").on(t.link_id),
  ],
)

export const schema = {
  apiKeys,
  domains,
  links,
  rules,
  qrCodes,
  visits,
  visitDays,
  visitCounts,
}
