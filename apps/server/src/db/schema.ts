import type { Condition } from "@linq/shared"
import { sql } from "drizzle-orm"
import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

export const roleEnum = pgEnum("role", ["viewer", "author", "editor", "admin"])
export const userStatusEnum = pgEnum("user_status", ["active", "disabled"])
export const resourceStatusEnum = pgEnum("resource_status", ["active", "archived"])
export const platformEnum = pgEnum("platform", ["android", "ios", "desktop"])

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()

/** Owners and principals. Users never log in; they act through api keys. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").unique(),
  role: roleEnum("role").notNull(),
  status: userStatusEnum("status").notNull().default("active"),
  createdAt,
  updatedAt,
})

/** Only the sha256 of the secret is stored; `prefix` exists so a key is recognisable. */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt,
  },
  (t) => [index("api_keys_user_id_idx").on(t.userId)],
)

export const domains = pgTable("domains", {
  id: uuid("id").primaryKey(),
  host: text("host").notNull().unique(),
  /** Where orphan clicks go. Null means 404. */
  fallbackUrl: text("fallback_url"),
  status: resourceStatusEnum("status").notNull().default("active"),
  createdAt,
  updatedAt,
})

/**
 * A slug is unique per domain and is never released: archiving keeps the row so
 * a dead link cannot be hijacked by a new linq. See docs/adr/0002.
 */
export const linqs = pgTable(
  "linqs",
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
    status: resourceStatusEnum("status").notNull().default("active"),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt,
    updatedAt,
  },
  (t) => [
    uniqueIndex("linqs_domain_slug_key").on(t.domainId, t.slug),
    index("linqs_owner_id_idx").on(t.ownerId),
    index("linqs_status_idx").on(t.status),
    index("linqs_tags_idx").using("gin", t.tags),
  ],
)

/** Ordered alternate destinations. Lowest position that matches wins. */
export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey(),
    linqId: uuid("linq_id")
      .notNull()
      .references(() => linqs.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    destination: text("destination").notNull(),
    conditions: jsonb("conditions").$type<Condition[]>().notNull(),
  },
  (t) => [uniqueIndex("rules_linq_position_key").on(t.linqId, t.position)],
)

/** One row per request. `linq_id` null means an orphan click. */
export const clicks = pgTable(
  "clicks",
  {
    id: uuid("id").primaryKey(),
    linqId: uuid("linq_id").references(() => linqs.id, { onDelete: "set null" }),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    slugRequested: text("slug_requested").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    isBot: boolean("is_bot").notNull(),
    platform: platformEnum("platform").notNull(),
    userAgent: text("user_agent"),
    referer: text("referer"),
    /** ISO-3166 alpha-2. The client IP itself is never stored, see docs/adr/0001. */
    country: char("country", { length: 2 }),
    region: text("region"),
    destination: text("destination"),
    query: jsonb("query").$type<Record<string, string[]>>(),
  },
  (t) => [
    index("clicks_linq_occurred_idx").on(t.linqId, t.occurredAt.desc()),
    index("clicks_domain_occurred_idx").on(t.domainId, t.occurredAt.desc()),
    index("clicks_orphan_occurred_idx").on(t.occurredAt.desc()).where(sql`${t.linqId} is null`),
  ],
)

export const schema = { users, apiKeys, domains, linqs, rules, clicks }
