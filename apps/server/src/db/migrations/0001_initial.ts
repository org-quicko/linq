import { type Kysely, sql } from "kysely"

/**
 * The complete schema for an empty database. Frozen: later changes go in new
 * migrations. Names are unqualified so every object lands in the connection's
 * search_path schema (LINQ_DB_SCHEMA). One statement per entry, because PGlite
 * rejects multi-statement queries.
 */
const statements = [
  `CREATE TYPE platform AS ENUM ('android', 'ios', 'desktop')`,
  `CREATE TYPE qr_pattern AS ENUM ('squares', 'rounded', 'dots')`,
  `CREATE TYPE resource_status AS ENUM ('active', 'archived')`,
  `CREATE TYPE visit_dimension AS ENUM ('total', 'platform', 'os', 'browser', 'referer', 'destination', 'slug')`,

  // The referer header's host, '' when absent. Backs visits.referer_host. See docs/adr/0015.
  `CREATE FUNCTION referer_host(u text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT lower(regexp_replace(regexp_replace(coalesce(u, ''),
    '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?', ''), '[/?#:].*$', ''))
$_$`,

  `CREATE TABLE api_keys (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    claims jsonb NOT NULL,
    key_hash text NOT NULL CONSTRAINT api_keys_key_hash_unique UNIQUE,
    prefix text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,

  `CREATE TABLE domains (
    id uuid PRIMARY KEY,
    host text NOT NULL CONSTRAINT domains_host_unique UNIQUE,
    fallback_url text,
    base_path_redirect text,
    invalid_short_url_redirect text,
    status resource_status DEFAULT 'active' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,

  `CREATE TABLE links (
    id uuid PRIMARY KEY,
    domain_id uuid NOT NULL CONSTRAINT links_domain_id_domains_id_fk REFERENCES domains(id) ON DELETE RESTRICT,
    slug text NOT NULL,
    destination text NOT NULL,
    name text,
    description text,
    icon_url text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    forward_query boolean DEFAULT true NOT NULL,
    preset_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status resource_status DEFAULT 'active' NOT NULL,
    expires_at timestamp with time zone,
    listed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE UNIQUE INDEX links_domain_slug_key ON links (domain_id, slug)`,
  `CREATE INDEX links_status_idx ON links (status)`,
  `CREATE INDEX links_tags_idx ON links USING gin (tags)`,
  `CREATE INDEX links_listed_idx ON links (domain_id) WHERE listed`,

  `CREATE TABLE rules (
    id uuid PRIMARY KEY,
    link_id uuid NOT NULL CONSTRAINT rules_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
    "position" integer NOT NULL,
    destination text NOT NULL,
    conditions jsonb NOT NULL
  )`,
  `CREATE UNIQUE INDEX rules_link_position_key ON rules (link_id, "position")`,

  `CREATE TABLE qr_codes (
    id uuid PRIMARY KEY,
    link_id uuid NOT NULL CONSTRAINT qr_codes_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
    name text,
    dot_color text DEFAULT '#000000' NOT NULL,
    bg_color text DEFAULT '#ffffff' NOT NULL,
    pattern qr_pattern DEFAULT 'squares' NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )`,
  `CREATE INDEX qr_codes_link_id_idx ON qr_codes (link_id)`,

  // One row per request; link_id null means an orphan visit.
  `CREATE TABLE visits (
    id uuid PRIMARY KEY,
    link_id uuid CONSTRAINT visits_link_id_links_id_fk REFERENCES links(id) ON DELETE CASCADE,
    domain_id uuid NOT NULL CONSTRAINT visits_domain_id_domains_id_fk REFERENCES domains(id) ON DELETE CASCADE,
    slug_requested text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    is_bot boolean NOT NULL,
    platform platform NOT NULL,
    os text,
    browser text,
    user_agent text,
    referer text,
    referer_host text GENERATED ALWAYS AS (referer_host(referer)) STORED,
    destination text,
    query jsonb
  ) WITH (autovacuum_vacuum_insert_scale_factor = 0.02)`,
  `CREATE INDEX visits_link_occurred_idx ON visits (link_id, occurred_at DESC NULLS LAST)`,
  `CREATE INDEX visits_domain_occurred_idx ON visits (domain_id, occurred_at DESC NULLS LAST)`,
  `CREATE INDEX visits_orphan_occurred_idx ON visits (occurred_at DESC NULLS LAST) WHERE link_id IS NULL`,
  // Covers every column a filtered report reads, for index-only scans. See docs/adr/0015.
  `CREATE INDEX visits_analytics_idx ON visits
    (occurred_at DESC NULLS LAST, is_bot, platform, link_id, domain_id, os, browser, referer_host, slug_requested)`,

  // Derived rollups, written only by the triggers below. link_id carries no
  // foreign key on purpose: a purge re-keys rows to the orphan scope. See docs/adr/0007.
  `CREATE TABLE visit_days (
    day date NOT NULL,
    domain_id uuid NOT NULL CONSTRAINT visit_days_domain_id_domains_id_fk REFERENCES domains(id) ON DELETE CASCADE,
    link_id uuid,
    dimension visit_dimension NOT NULL,
    value text NOT NULL,
    is_bot boolean NOT NULL,
    count bigint DEFAULT 0 NOT NULL,
    CONSTRAINT visit_days_key UNIQUE NULLS NOT DISTINCT (day, domain_id, link_id, dimension, value, is_bot)
  )`,
  `CREATE INDEX visit_days_link_idx ON visit_days (link_id, dimension, day)`,
  `CREATE INDEX visit_days_domain_idx ON visit_days (domain_id, dimension, day)`,
  `CREATE INDEX visit_days_dimension_day_idx ON visit_days (dimension, day)`,

  `CREATE TABLE visit_counts (
    domain_id uuid NOT NULL CONSTRAINT visit_counts_domain_id_domains_id_fk REFERENCES domains(id) ON DELETE CASCADE,
    link_id uuid,
    human bigint DEFAULT 0 NOT NULL,
    bot bigint DEFAULT 0 NOT NULL,
    last_visit_at timestamp with time zone,
    CONSTRAINT visit_counts_key UNIQUE NULLS NOT DISTINCT (domain_id, link_id)
  )`,
  `CREATE INDEX visit_counts_link_idx ON visit_counts (link_id)`,

  `CREATE FUNCTION record_visit_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,       ''::text),
    ('platform'::visit_dimension,    new.platform::text),
    ('os'::visit_dimension,          coalesce(new.os, '')::text),
    ('browser'::visit_dimension,     coalesce(new.browser, '')::text),
    ('referer'::visit_dimension,     coalesce(new.referer_host, '')::text),
    ('destination'::visit_dimension, coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,        new.slug_requested::text)
  ) AS dims(dim, val)
  ON CONFLICT ("day", "domain_id", "link_id", "dimension", "value", "is_bot")
    DO UPDATE SET "count" = "visit_days"."count" + 1;
  INSERT INTO "visit_counts" ("domain_id", "link_id", "human", "bot", "last_visit_at")
  VALUES (
    new.domain_id,
    new.link_id,
    CASE WHEN new.is_bot THEN 0 ELSE 1 END,
    CASE WHEN new.is_bot THEN 1 ELSE 0 END,
    new.occurred_at
  )
  ON CONFLICT ("domain_id", "link_id") DO UPDATE SET
    "human" = "visit_counts"."human" + excluded."human",
    "bot" = "visit_counts"."bot" + excluded."bot",
    "last_visit_at" = greatest("visit_counts"."last_visit_at", excluded."last_visit_at");
  RETURN NULL;
END $$`,
  `CREATE TRIGGER visits_rollup AFTER INSERT ON visits FOR EACH ROW EXECUTE FUNCTION record_visit_rollup()`,

  `CREATE FUNCTION orphan_visit_rollups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM "visit_days" WHERE "link_id" = old.id;
  DELETE FROM "visit_counts" WHERE "link_id" = old.id;
  RETURN NULL;
END $$`,
  `CREATE TRIGGER links_purge_rollup AFTER DELETE ON links FOR EACH ROW EXECUTE FUNCTION orphan_visit_rollups()`,
]

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
