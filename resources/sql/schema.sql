--
-- PostgreSQL database dump
--

\restrict linq

-- Dumped from database version 17.11 (Debian 17.11-1.pgdg13+2)
-- Dumped by pg_dump version 17.11 (Debian 17.11-1.pgdg13+2)

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
-- Name: platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.platform AS ENUM (
    'android',
    'ios',
    'desktop'
);


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
-- Name: link_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.link_tags (
    link_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


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
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


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

\unrestrict linq

