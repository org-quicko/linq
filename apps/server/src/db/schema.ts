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

export const roleEnum = pgEnum("role", ["viewer", "author", "manager", "admin"])
export const resourceStatusEnum = pgEnum("resource_status", ["active", "archived"])
export const platformEnum = pgEnum("platform", ["android", "ios", "desktop"])

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

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
  keyHash: text("key_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt,
  updatedAt,
})

export const domains = pgTable("domains", {
  id: uuid("id").primaryKey(),
  host: text("host").notNull().unique(),
  /** Where orphan visits go. Null means 404. */
  fallbackUrl: text("fallback_url"),
  status: resourceStatusEnum("status").notNull().default("active"),
  createdAt,
  updatedAt,
})

/**
 * A slug is unique per domain and is never released: archiving keeps the row so
 * a dead link cannot be hijacked by a new one. See docs/adr/0002.
 */
export const links = pgTable(
  "links",
  {
    id: uuid("id").primaryKey(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    destination: text("destination").notNull(),
    name: text("name"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    forwardQuery: boolean("forward_query").notNull().default(true),
    presetParams: jsonb("preset_params").$type<Record<string, string>>().notNull().default({}),
    status: resourceStatusEnum("status").notNull().default("active"),
    /**
     * The key that created it. Nullable: revoking a key must always succeed, so
     * its links are left unowned rather than holding the revoke hostage. An
     * unowned link is editable by a manager or admin. See docs/adr/0011.
     */
    ownerId: uuid("owner_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Past this, the link resolves like an unknown slug. Null never expires. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Opt-in: listed in this domain's public /llms.txt catalogue. Off by
     *  default, because listing publishes a link's slug, name and
     *  destination to anyone. */
    listed: boolean("listed").notNull().default(false),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("links_domain_slug_key").on(t.domainId, t.slug),
    index("links_owner_id_idx").on(t.ownerId),
    index("links_status_idx").on(t.status),
    index("links_tags_idx").using("gin", t.tags),
    index("links_listed_idx").on(t.domainId).where(sql`${t.listed}`),
  ],
)

/** Ordered alternate destinations. Lowest position that matches wins. */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => links.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    destination: text("destination").notNull(),
    conditions: jsonb("conditions").$type<Condition[]>().notNull(),
  },
  (t) => [uniqueIndex("rules_link_position_key").on(t.linkId, t.position)],
)

/** One row per request. `link_id` null means an orphan visit. */
export const visits = pgTable(
  "visits",
  {
    id: uuid("id").primaryKey(),
    linkId: uuid("link_id").references(() => links.id, { onDelete: "cascade" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    slugRequested: text("slug_requested").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    isBot: boolean("is_bot").notNull(),
    platform: platformEnum("platform").notNull(),
    os: text("os"),
    browser: text("browser"),
    botLabel: text("bot_label"),
    userAgent: text("user_agent"),
    referer: text("referer"),
    destination: text("destination"),
    query: jsonb("query").$type<Record<string, string[]>>(),
  },
  (t) => [
    index("visits_link_occurred_idx").on(t.linkId, t.occurredAt.desc()),
    index("visits_domain_occurred_idx").on(t.domainId, t.occurredAt.desc()),
    index("visits_orphan_occurred_idx").on(t.occurredAt.desc()).where(sql`${t.linkId} is null`),
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
  "botLabel",
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
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    linkId: uuid("link_id"),
    dimension: visitDimensionEnum("dimension").notNull(),
    /** Empty string where the dimension was not recorded, never a word a real value could collide with. */
    value: text("value").notNull(),
    isBot: boolean("is_bot").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    // NULLS NOT DISTINCT, so the orphan scope upserts onto one row per key
    // instead of inserting a new one every time. Needs Postgres 15+.
    unique("visit_days_key")
      .on(t.day, t.domainId, t.linkId, t.dimension, t.value, t.isBot)
      .nullsNotDistinct(),
    index("visit_days_link_idx").on(t.linkId, t.dimension, t.day),
    index("visit_days_domain_idx").on(t.domainId, t.dimension, t.day),
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
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    linkId: uuid("link_id"),
    human: bigint("human", { mode: "number" }).notNull().default(0),
    bot: bigint("bot", { mode: "number" }).notNull().default(0),
    lastVisitAt: timestamp("last_visit_at", { withTimezone: true }),
  },
  (t) => [
    unique("visit_counts_key").on(t.domainId, t.linkId).nullsNotDistinct(),
    // The join every link response makes; the constraint above leads with the
    // domain and cannot serve it.
    index("visit_counts_link_idx").on(t.linkId),
  ],
)

export const schema = {
  apiKeys,
  domains,
  links,
  rules,
  visits,
  visitDays,
  visitCounts,
}
