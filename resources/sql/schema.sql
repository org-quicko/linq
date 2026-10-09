--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: bot_classification; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bot_classification AS ENUM (
    'missing_user_agent',
    'isbot_match',
    'pattern_match',
    'unknown'
);


--
-- Name: TYPE bot_classification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.bot_classification IS 'Why ingest classified a visit as a bot, or unknown for one it did not.';


--
-- Name: platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.platform AS ENUM (
    'android',
    'ios',
    'desktop'
);


--
-- Name: TYPE platform; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.platform IS 'The routing value Rules match on. desktop is also the fallback for an unknown or absent user agent.';


--
-- Name: qr_pattern; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.qr_pattern AS ENUM (
    'squares',
    'rounded',
    'dots'
);


--
-- Name: resource_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.resource_status AS ENUM (
    'active',
    'archived'
);


--
-- Name: TYPE resource_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.resource_status IS 'active, or archived: soft-deleted, keeping its rows and, for a link, its slug.';


--
-- Name: visit_dimension; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.visit_dimension AS ENUM (
    'total',
    'platform',
    'os',
    'browser',
    'referer',
    'destination',
    'slug',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'device_type'
);


--
-- Name: TYPE visit_dimension; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TYPE public.visit_dimension IS 'A visit_days grouping. total counts every visit of the day and is what the day grouping reads.';


--
-- Name: orphan_visit_rollups(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orphan_visit_rollups() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  DELETE FROM "visit_days" WHERE "link_id" = old.id;
  DELETE FROM "visit_counts" WHERE "link_id" = old.id;
  RETURN NULL;
END $$;


--
-- Name: record_visit_rollup(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_visit_rollup() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  d date := (new.occurred_at AT TIME ZONE 'UTC')::date;
BEGIN
  INSERT INTO "visit_days" ("day", "domain_id", "link_id", "dimension", "value", "is_bot", "count")
  SELECT d, new.domain_id, new.link_id, dims.dim, dims.val, new.is_bot, 1
  FROM (VALUES
    ('total'::visit_dimension,        ''::text),
    ('platform'::visit_dimension,     new.platform::text),
    ('os'::visit_dimension,           coalesce(new.os, '')::text),
    ('browser'::visit_dimension,      coalesce(new.browser, '')::text),
    ('referer'::visit_dimension,      coalesce(new.referer_host, '')::text),
    ('destination'::visit_dimension,  coalesce(new.destination, '')::text),
    ('slug'::visit_dimension,         new.slug_requested::text),
    ('utm_source'::visit_dimension,   coalesce(new.utm_source, '')::text),
    ('utm_medium'::visit_dimension,   coalesce(new.utm_medium, '')::text),
    ('utm_campaign'::visit_dimension, coalesce(new.utm_campaign, '')::text),
    ('utm_content'::visit_dimension,  coalesce(new.utm_content, '')::text),
    ('utm_term'::visit_dimension,     coalesce(new.utm_term, '')::text),
    ('device_type'::visit_dimension,  coalesce(new.device_type, '')::text)
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
END $$;


--
-- Name: referer_host(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.referer_host(u text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $_$
  SELECT lower(regexp_replace(regexp_replace(coalesce(u, ''),
    '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?', ''), '[/?#:].*$', ''))
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid NOT NULL,
    name text NOT NULL,
    claims jsonb NOT NULL,
    key_hash text NOT NULL,
    prefix text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE api_keys; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.api_keys IS 'The principal. There are no user rows: a key carries its own name and claims, so authentication is one row and no join (resources/docs/adr/0011, 0017). Revoking a key deletes the row. Links carry no reference to the key that created them, so revoking never touches them (resources/docs/adr/0016).';


--
-- Name: COLUMN api_keys.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.name IS 'Who or what the key is for.';


--
-- Name: COLUMN api_keys.claims; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.claims IS 'CASL action/subject rules the key is allowed, evaluated on every request (resources/docs/adr/0017).';


--
-- Name: COLUMN api_keys.key_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.key_hash IS 'sha256 of the secret. The secret itself is shown once and never stored.';


--
-- Name: COLUMN api_keys.prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.prefix IS 'First characters of the key, so it is recognisable in a list.';


--
-- Name: COLUMN api_keys.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.api_keys.expires_at IS 'Null never expires.';


--
-- Name: domains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.domains (
    id uuid NOT NULL,
    host text NOT NULL,
    fallback_url text,
    base_path_redirect text,
    invalid_short_url_redirect text,
    status public.resource_status DEFAULT 'active'::public.resource_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE domains; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.domains IS 'A host that serves short links, with what to do when a request matches no link.';


--
-- Name: COLUMN domains.host; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domains.host IS 'Lowercased, optionally carrying a port.';


--
-- Name: COLUMN domains.fallback_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domains.fallback_url IS 'Where an unmatched but well-formed slug goes. Null means 404.';


--
-- Name: COLUMN domains.base_path_redirect; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domains.base_path_redirect IS 'Where a bare GET / (empty slug) goes. Null falls back to fallback_url, then 404.';


--
-- Name: COLUMN domains.invalid_short_url_redirect; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.domains.invalid_short_url_redirect IS 'Where a malformed (not just unknown) slug goes. Null falls back to fallback_url, then 404.';


--
-- Name: link_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_tags (
    link_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: TABLE link_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.link_tags IS 'A link carries a tag. At most 20 per link. Unordered: the API returns a link''s tags sorted by name.';


--
-- Name: links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.links (
    id uuid NOT NULL,
    domain_id uuid NOT NULL,
    slug text NOT NULL,
    destination text NOT NULL,
    name text,
    description text,
    icon_url text,
    forward_query boolean DEFAULT true NOT NULL,
    preset_params jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.resource_status DEFAULT 'active'::public.resource_status NOT NULL,
    expires_at timestamp with time zone,
    listed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE links; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.links IS 'One short link: a slug on a domain. Archiving keeps the row so a dead link cannot be hijacked by a new one; only a purge releases the slug (resources/docs/adr/0002).';


--
-- Name: COLUMN links.domain_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.domain_id IS 'Immutable. ON DELETE RESTRICT: a domain cannot be purged while any link row points at it.';


--
-- Name: COLUMN links.slug; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.slug IS 'Immutable, and never released except by a purge.';


--
-- Name: COLUMN links.description; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.description IS 'Filled from the destination''s <head> when the request did not supply one (resources/docs/adr/0014).';


--
-- Name: COLUMN links.icon_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.icon_url IS 'The destination''s favicon, resolved to an absolute URL (resources/docs/adr/0014).';


--
-- Name: COLUMN links.forward_query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.forward_query IS 'Merge the incoming query string over the destination.';


--
-- Name: COLUMN links.preset_params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.preset_params IS 'Record<string, string>, at most 20. Set on the destination when forward_query is true, overriding its own query and the forwarded one.';


--
-- Name: COLUMN links.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.expires_at IS 'Past this, the link resolves like an unknown slug. Null never expires.';


--
-- Name: COLUMN links.listed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.links.listed IS 'Opt-in: listed in the domain''s public /llms.txt catalogue (resources/docs/adr/0013).';


--
-- Name: qr_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qr_codes (
    id uuid NOT NULL,
    link_id uuid NOT NULL,
    name text,
    dot_color text DEFAULT '#000000'::text NOT NULL,
    bg_color text DEFAULT '#ffffff'::text NOT NULL,
    pattern public.qr_pattern DEFAULT 'squares'::public.qr_pattern NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE qr_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.qr_codes IS 'A styled QR code for a link. The encoded data is never stored: it is always the link''s current short URL, resolved at render time, so only the styling lives here. Deleted, not archived (resources/docs/adr/0002).';


--
-- Name: rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rules (
    id uuid NOT NULL,
    link_id uuid NOT NULL,
    "position" integer NOT NULL,
    destination text NOT NULL,
    conditions jsonb NOT NULL
);


--
-- Name: TABLE rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.rules IS 'Ordered alternate destinations for a link, at most 50. The lowest matching position wins.';


--
-- Name: COLUMN rules."position"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rules."position" IS 'Server-owned, gapless from 0.';


--
-- Name: COLUMN rules.conditions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.rules.conditions IS 'Condition[]: platform | query_param. ANDed, never empty, at most 10.';


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tags IS 'Every tag name ever attached to a link. A tag no link carries any more stays here but drops out of GET /v1/tags, which counts through link_tags (resources/docs/adr/0020).';


--
-- Name: COLUMN tags.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.tags.name IS 'Lowercased and trimmed by the API, at most 50 characters.';


--
-- Name: visit_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visit_counts (
    domain_id uuid NOT NULL,
    link_id uuid,
    human bigint DEFAULT 0 NOT NULL,
    bot bigint DEFAULT 0 NOT NULL,
    last_visit_at timestamp with time zone
);


--
-- Name: TABLE visit_counts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.visit_counts IS 'All-time totals per scope: one row per link, plus one per domain for its orphans. What link lists and overview tiles read instead of aggregating visits. Derived, and link_id has no foreign key, for the same reasons as visit_days.';


--
-- Name: COLUMN visit_counts.link_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visit_counts.link_id IS 'Null is the orphan scope, one row per domain. No foreign key; see visit_days.';


--
-- Name: visit_days; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visit_days (
    day date NOT NULL,
    domain_id uuid NOT NULL,
    link_id uuid,
    dimension public.visit_dimension NOT NULL,
    value text NOT NULL,
    is_bot boolean NOT NULL,
    count bigint DEFAULT 0 NOT NULL
);


--
-- Name: TABLE visit_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.visit_days IS 'Pre-counted visits: one row per day, scope, dimension value and bot flag, serving every grouping the stats API offers (resources/docs/adr/0007). Derived: only the visits_rollup trigger writes here, thirteen rows per visit. link_id deliberately has no foreign key: purging a link merges its rows into the orphan scope, which ON DELETE SET NULL would pre-empt and collide on the unique key. domain_id cascades, so purging a domain destroys its rollups with its visits.';


--
-- Name: COLUMN visit_days.day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visit_days.day IS 'Cut in UTC, so a report never shifts with the session timezone.';


--
-- Name: COLUMN visit_days.link_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visit_days.link_id IS 'Null is the orphan scope. No foreign key; see the table comment.';


--
-- Name: COLUMN visit_days.value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visit_days.value IS 'Empty string where the dimension was not recorded, never a word a real value could collide with. The referer dimension holds a host, not the full URL.';


--
-- Name: visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visits (
    id uuid NOT NULL,
    link_id uuid,
    domain_id uuid NOT NULL,
    slug_requested text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    is_bot boolean NOT NULL,
    platform public.platform NOT NULL,
    os text,
    browser text,
    user_agent text,
    referer text,
    referer_host text GENERATED ALWAYS AS (public.referer_host(referer)) STORED,
    destination text,
    query jsonb,
    bot_classification public.bot_classification,
    utm_source text GENERATED ALWAYS AS (NULLIF("left"(lower(btrim(((query -> 'utm_source'::text) ->> 0))), 200), ''::text)) STORED,
    utm_medium text GENERATED ALWAYS AS (NULLIF("left"(lower(btrim(((query -> 'utm_medium'::text) ->> 0))), 200), ''::text)) STORED,
    utm_campaign text GENERATED ALWAYS AS (NULLIF("left"(lower(btrim(((query -> 'utm_campaign'::text) ->> 0))), 200), ''::text)) STORED,
    utm_content text GENERATED ALWAYS AS (NULLIF("left"(lower(btrim(((query -> 'utm_content'::text) ->> 0))), 200), ''::text)) STORED,
    utm_term text GENERATED ALWAYS AS (NULLIF("left"(lower(btrim(((query -> 'utm_term'::text) ->> 0))), 200), ''::text)) STORED,
    device_type text GENERATED ALWAYS AS (
CASE
    WHEN (NULLIF(btrim(user_agent), ''::text) IS NULL) THEN NULL::text
    WHEN ((user_agent ~* 'ipad|tablet|kindle|silk/|playbook'::text) OR ((user_agent ~* 'android'::text) AND (user_agent !~* 'mobi'::text))) THEN 'tablet'::text
    WHEN (user_agent ~* 'mobi|iphone|ipod|android|blackberry|opera mini|windows phone'::text) THEN 'mobile'::text
    ELSE 'desktop'::text
END) STORED,
    country text,
    region text
)
WITH (autovacuum_vacuum_insert_scale_factor='0.02');


--
-- Name: TABLE visits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.visits IS 'One row per request, inserted fire-and-forget so a visit never delays a redirect. The only source of truth for analytics: visit_days and visit_counts are derived from it by trigger (resources/docs/adr/0007).';


--
-- Name: COLUMN visits.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.id IS 'UUIDv7, so it breaks ties in the order visits happened.';


--
-- Name: COLUMN visits.link_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.link_id IS 'Null is an orphan visit. ON DELETE CASCADE, so purging a link destroys its visits.';


--
-- Name: COLUMN visits.slug_requested; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.slug_requested IS 'What the caller asked for. Empty for the root path.';


--
-- Name: COLUMN visits.is_bot; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.is_bot IS 'Decided once at ingest. No user agent at all counts as a bot.';


--
-- Name: COLUMN visits.os; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.os IS 'Open vocabulary (unlike platform), lowercased. Null when it could not be determined.';


--
-- Name: COLUMN visits.browser; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.browser IS 'Open vocabulary (unlike platform), lowercased. Null when it could not be determined.';


--
-- Name: COLUMN visits.referer_host; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.referer_host IS 'Generated: the host of referer. Empty for an absent or relative URL (resources/docs/adr/0015).';


--
-- Name: COLUMN visits.destination; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.destination IS 'The URL actually chosen, after rules, before query merging.';


--
-- Name: COLUMN visits.query; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.query IS 'Record<string, string[]> of the incoming query, before any merging.';


--
-- Name: COLUMN visits.bot_classification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.bot_classification IS 'Why is_bot was decided. Null on visits recorded before it existed, or imported without one.';


--
-- Name: COLUMN visits.utm_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.utm_source IS 'Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.';


--
-- Name: COLUMN visits.utm_medium; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.utm_medium IS 'Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.';


--
-- Name: COLUMN visits.utm_campaign; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.utm_campaign IS 'Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.';


--
-- Name: COLUMN visits.utm_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.utm_content IS 'Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.';


--
-- Name: COLUMN visits.utm_term; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.utm_term IS 'Generated from query: first value, lowercased and trimmed, capped at 200 characters. Null when absent or blank.';


--
-- Name: COLUMN visits.device_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.device_type IS 'Generated from user_agent: mobile, tablet or desktop. Null when the user agent is absent or blank.';


--
-- Name: COLUMN visits.country; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.country IS 'ISO 3166-1 alpha-2. Only imported data fills it; linq does not capture it yet (resources/docs/adr/0021).';


--
-- Name: COLUMN visits.region; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.visits.region IS 'Region name. Only imported data fills it; linq does not capture it yet (resources/docs/adr/0021).';


--
-- Name: api_keys api_keys_key_hash_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_unique UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: domains domains_host_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_host_unique UNIQUE (host);


--
-- Name: domains domains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);


--
-- Name: link_tags link_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_tags
    ADD CONSTRAINT link_tags_pkey PRIMARY KEY (link_id, tag_id);


--
-- Name: links links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_pkey PRIMARY KEY (id);


--
-- Name: qr_codes qr_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qr_codes
    ADD CONSTRAINT qr_codes_pkey PRIMARY KEY (id);


--
-- Name: rules rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rules
    ADD CONSTRAINT rules_pkey PRIMARY KEY (id);


--
-- Name: tags tags_name_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_unique UNIQUE (name);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: visit_counts visit_counts_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_counts
    ADD CONSTRAINT visit_counts_key UNIQUE NULLS NOT DISTINCT (domain_id, link_id);


--
-- Name: visit_days visit_days_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_days
    ADD CONSTRAINT visit_days_key UNIQUE NULLS NOT DISTINCT (day, domain_id, link_id, dimension, value, is_bot);


--
-- Name: visits visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_pkey PRIMARY KEY (id);


--
-- Name: link_tags_tag_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX link_tags_tag_id_idx ON public.link_tags USING btree (tag_id);


--
-- Name: links_domain_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX links_domain_slug_key ON public.links USING btree (domain_id, slug);


--
-- Name: links_listed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_listed_idx ON public.links USING btree (domain_id) WHERE listed;


--
-- Name: links_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX links_status_idx ON public.links USING btree (status);


--
-- Name: qr_codes_link_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qr_codes_link_id_idx ON public.qr_codes USING btree (link_id);


--
-- Name: rules_link_position_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX rules_link_position_key ON public.rules USING btree (link_id, "position");


--
-- Name: visit_counts_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_counts_link_idx ON public.visit_counts USING btree (link_id);


--
-- Name: visit_days_dimension_day_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_days_dimension_day_idx ON public.visit_days USING btree (dimension, day);


--
-- Name: visit_days_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_days_domain_idx ON public.visit_days USING btree (domain_id, dimension, day);


--
-- Name: visit_days_link_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_days_link_idx ON public.visit_days USING btree (link_id, dimension, day);


--
-- Name: visits_analytics_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_analytics_idx ON public.visits USING btree (occurred_at DESC NULLS LAST, is_bot, platform, link_id, domain_id, os, browser, referer_host, slug_requested, utm_source, utm_medium, utm_campaign, utm_content, utm_term, device_type);


--
-- Name: visits_domain_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_domain_occurred_idx ON public.visits USING btree (domain_id, occurred_at DESC NULLS LAST);


--
-- Name: visits_link_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_link_occurred_idx ON public.visits USING btree (link_id, occurred_at DESC NULLS LAST);


--
-- Name: visits_orphan_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visits_orphan_occurred_idx ON public.visits USING btree (occurred_at DESC NULLS LAST) WHERE (link_id IS NULL);


--
-- Name: links links_purge_rollup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER links_purge_rollup AFTER DELETE ON public.links FOR EACH ROW EXECUTE FUNCTION public.orphan_visit_rollups();


--
-- Name: visits visits_rollup; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER visits_rollup AFTER INSERT ON public.visits FOR EACH ROW EXECUTE FUNCTION public.record_visit_rollup();


--
-- Name: link_tags link_tags_link_id_links_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_tags
    ADD CONSTRAINT link_tags_link_id_links_id_fk FOREIGN KEY (link_id) REFERENCES public.links(id) ON DELETE CASCADE;


--
-- Name: link_tags link_tags_tag_id_tags_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.link_tags
    ADD CONSTRAINT link_tags_tag_id_tags_id_fk FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: links links_domain_id_domains_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.links
    ADD CONSTRAINT links_domain_id_domains_id_fk FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE RESTRICT;


--
-- Name: qr_codes qr_codes_link_id_links_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qr_codes
    ADD CONSTRAINT qr_codes_link_id_links_id_fk FOREIGN KEY (link_id) REFERENCES public.links(id) ON DELETE CASCADE;


--
-- Name: rules rules_link_id_links_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rules
    ADD CONSTRAINT rules_link_id_links_id_fk FOREIGN KEY (link_id) REFERENCES public.links(id) ON DELETE CASCADE;


--
-- Name: visit_counts visit_counts_domain_id_domains_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_counts
    ADD CONSTRAINT visit_counts_domain_id_domains_id_fk FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE CASCADE;


--
-- Name: visit_days visit_days_domain_id_domains_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_days
    ADD CONSTRAINT visit_days_domain_id_domains_id_fk FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE CASCADE;


--
-- Name: visits visits_domain_id_domains_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_domain_id_domains_id_fk FOREIGN KEY (domain_id) REFERENCES public.domains(id) ON DELETE CASCADE;


--
-- Name: visits visits_link_id_links_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visits
    ADD CONSTRAINT visits_link_id_links_id_fk FOREIGN KEY (link_id) REFERENCES public.links(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


