import { type Condition, RESERVED_SLUGS, SLUG_PATTERN } from "@linq/shared"
import { and, eq, inArray } from "drizzle-orm"
import type { Context } from "hono"
import { createFactory } from "hono/factory"
import { domainKey, targetKey } from "../cache.ts"
import type { Db } from "../db/client.ts"
import { domains, links } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"
import { matchRules } from "../rules/match.ts"
import { listRules } from "../rules/store.ts"
import { detectBot, isPreviewCrawler } from "../visits/bot.ts"
import { detectBrowser, detectOs, detectPlatform } from "../visits/platform.ts"
import { recordVisit } from "../visits/record.ts"
import { shortUrl } from "./api/links.ts"
import type { Env } from "./env.ts"

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
      const candidates = candidateHosts(hostHeader)

      const rows = await db
        .select({
          id: domains.id,
          host: domains.host,
          fallback_url: domains.fallback_url,
          base_path_redirect: domains.base_path_redirect,
          invalid_short_url_redirect: domains.invalid_short_url_redirect,
        })
        .from(domains)
        .where(and(inArray(domains.host, candidates), eq(domains.status, "active")))

      const row = rows.find((r) => r.host === host) ?? rows[0] ?? null
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
 * archived. Used only to decide the root path's admin-UI fallback below,
 * which must fire for a host nobody registered but never for an archived
 * one — that stays a 404 for everything, root path included, same as
 * `findActiveDomain` already guarantees for a slug. Deliberately uncached
 * and only ever queried once `findActiveDomain` has already missed, since it
 * exists purely to cover the rare "unclaimed root path" case, not the hot
 * redirect path.
 */
function hostHasAnyDomain(db: Db, hostHeader: string): Promise<boolean> {
  return span(
    "domain.hostHasAny",
    async () => {
      const rows = await db
        .select({ id: domains.id })
        .from(domains)
        .where(inArray(domains.host, candidateHosts(hostHeader)))
        .limit(1)
      return rows.length > 0
    },
    { in: { host: hostHeader } },
  )
}

/**
 * Looks up what a slug resolves to on one domain, rules included. Archived links
 * are invisible here.
 */
function findActiveTarget(db: Db, domain_id: string, slug: string): Promise<ResolvedTarget | null> {
  return span(
    "link.findActive",
    async () => {
      const [row] = await db
        .select()
        .from(links)
        .where(and(eq(links.domain_id, domain_id), eq(links.slug, slug), eq(links.status, "active")))
        .limit(1)
      if (!row) return null
      // Rules ride inside the same entry: every hit that resolves reads them, so
      // caching the link without them would leave a query behind on the hot path.
      const ordered = await listRules(db, row.id)
      return {
        link_id: row.id,
        name: row.name,
        destination: row.destination,
        forward_query: row.forward_query,
        preset_params: row.preset_params,
        rules: ordered.map((r) => ({ destination: r.destination, conditions: r.conditions })),
        expires_at: row.expires_at?.getTime() ?? null,
      }
    },
    { in: { domain_id, slug }, out: (target) => ({ link_id: target?.link_id ?? null }) },
  )
}

/**
 * Reads one key through the cache, falling back to `load` on a miss and writing
 * the answer back — a `null` answer included, so an unknown host or slug costs
 * one query per TTL rather than one per request.
 */
export async function through<T>(
  c: Context<Env>,
  key: string,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = await c.var.cache.get<T | null>(key)
  if (hit) return hit.value
  const value = await load()
  await c.var.cache.set(key, value)
  return value
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

/** Preset params win over everything already on the URL. None leaves it untouched. */
function applyPresets(destination: string, presets: Record<string, string>): string {
  return Object.keys(presets).length
    ? mergeQuery(destination, new URLSearchParams(presets))
    : destination
}

/** The visit's record of what the caller asked for, before any merging. */
export function queryMap(params: URLSearchParams): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const [key, value] of params) {
    const seen = out[key]
    if (seen) seen.push(value)
    else out[key] = [value]
  }
  return Object.keys(out).length ? out : null
}

/**
 * A link past its expiry is a stranger. Checked here rather than in
 * `findActiveTarget`'s WHERE clause because the cached entry outlives the moment it
 * lapses and no mutation ever arrives to invalidate it: `status` is safe in SQL only
 * because every status change also dels `targetKey`.
 */
function expired(target: ResolvedTarget): boolean {
  return typeof target.expires_at === "number" && target.expires_at <= Date.now()
}

const factory = createFactory<Env>()

/**
 * `GET|HEAD /:slug` and `GET|HEAD /`. Mounted last so every path linq answers
 * itself has already been claimed.
 */
export const redirectHandler = factory.createHandlers(async (c) => {
  const url = new URL(c.req.url)
  const slug = url.pathname.slice(1)

  // 1. Reserved paths belong to the API, the Client UI and robots.txt. Matching on
  //    the first segment covers /api/v1/typo and /home/whatever too, so an
  //    unclaimed one 404s instead of becoming an orphan visit on the fallback.
  const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
  if (RESERVED_SLUGS.has(firstSegment)) return c.text("Not Found", 404)

  // 2. An unknown or archived domain is not ours to report on — except at the
  //    root path of a host nobody ever registered at all, where the Client
  //    UI is a friendlier landing place than a bare 404 and costs nothing
  //    since no domain's own redirect could ever have claimed it. An
  //    archived domain's root path stays a 404 like everything else on it
  //    (hostHasAnyDomain is what tells the two apart).
  const host = c.req.header("host") ?? url.host
  const domain = await through(c, domainKey(host), () => findActiveDomain(c.var.db, host))
  if (!domain) {
    if (slug === "" && !(await hostHasAnyDomain(c.var.db, host))) return redirectToAdmin(c)
    return c.text("Not Found", 404)
  }

  // HEAD is answered exactly like GET but never tracked.
  const tracked = c.req.method === "GET"
  const user_agent = c.req.header("user-agent") ?? null
  const cached = slug
    ? await through(c, targetKey(domain.id, slug), () =>
        findActiveTarget(c.var.db, domain.id, slug),
      )
    : null

  // 2b. An expired link is an unknown slug: same orphan path, same null
  //     link_id, same fallback. See `expired` for why this is not a WHERE.
  const isExpired = cached !== null && expired(cached)
  if (isExpired) reqLog().debug({ link_id: cached.link_id, slug }, "link expired")
  const link = isExpired ? null : cached

  const visit = {
    domain_id: domain.id,
    slug_requested: slug,
    is_bot: detectBot(user_agent),
    platform: detectPlatform(user_agent),
    os: detectOs(user_agent),
    browser: detectBrowser(user_agent),
    user_agent,
    referer: c.req.header("referer") ?? null,
    query: queryMap(url.searchParams),
  }

  // 3. Root path, unknown slug or archived link: an orphan visit on a live domain.
  //    Three redirect fields, three cases, in this order — root path wins over
  //    malformed (an empty slug also fails SLUG_PATTERN, so it must be checked
  //    first), and each falls back to `fallback_url` when unset. `?? null`
  //    guards a cache entry written before these fields existed (see
  //    ResolvedDomain), not the DB row, which is always complete.
  //
  //    No admin-UI fallback here, unlike the unknown-domain 404 above: this
  //    domain was deliberately registered as a real shortening domain, so an
  //    operator who never got around to configuring its root redirect gets
  //    the same 404 as any other unclaimed path — not a surprise landing
  //    page. The fallback only ever covers a host nobody registered at all.
  if (!link) {
    const destination =
      slug === ""
        ? (domain.base_path_redirect ?? domain.fallback_url)
        : SLUG_PATTERN.test(slug)
          ? domain.fallback_url
          : (domain.invalid_short_url_redirect ?? domain.fallback_url)
    if (tracked) recordVisit(c.var.db, { ...visit, link_id: null, destination })
    if (!destination) return c.text("Not Found", 404)
    return isPreviewCrawler(user_agent)
      ? ogPreview(c, host, slug, null)
      : sendRedirect(c, destination)
  }

  // 4-5. Build the match context, then let the first rule whose conditions all
  //      hold supply the destination. No match falls back to the link default.
  const ruled = matchRules(link.rules, {
    platform: visit.platform,
    query: url.searchParams,
  })
  const chosen = ruled ?? link.destination
  // `matchRules` is synchronous and on the hot path, so it gets one line rather
  // than a span; which branch won is the only part worth recording.
  reqLog().debug({ link_id: link.link_id, matchedRule: ruled !== null }, "rules matched")

  // 6. `forward_query` is the link's switch for touching the outgoing query at
  //    all: off passes the destination through exactly as written, presets
  //    included. On, the incoming query merges in first and the link's own
  //    preset params then overwrite whatever is there — the destination's query
  //    and the forwarded one alike. This only ever affects where the browser is
  //    sent, never what gets recorded: the visit's own `query` field already
  //    carries whatever the caller sent, so baking it into `destination` too
  //    would double-count it and fragment one real destination into one bucket
  //    per distinct querystring.
  const sendTo = link.forward_query
    ? applyPresets(mergeQuery(chosen, url.searchParams), link.preset_params)
    : chosen

  // 8. Insert after the response is built, and never await it. Recorded as
  //    `chosen` — the Destination the link or rule actually names — not
  //    `sendTo`, which is a different, effectively unique string per click.
  if (tracked) recordVisit(c.var.db, { ...visit, link_id: link.link_id, destination: chosen })

  return isPreviewCrawler(user_agent) ? ogPreview(c, host, slug, link) : sendRedirect(c, sendTo)
})

/** 7. Always 302, never cached: the destination can change under a live slug. */
function sendRedirect(c: Context<Env>, destination: string) {
  c.header("cache-control", "no-store")
  return c.redirect(destination, 302)
}

/**
 * The root path's fallback of last resort. Not cached, for the same reason
 * as `sendRedirect`: configuring a base path redirect later must take over
 * immediately, not wait out a stale 302 some intermediary held onto.
 */
function redirectToAdmin(c: Context<Env>) {
  c.header("cache-control", "no-store")
  return c.redirect("/home/", 302)
}

/**
 * What a link-preview crawler gets instead of the redirect: the short link's
 * own title, never the destination's. `link` is null on the orphan path,
 * where there's nothing to title it with but the domain itself.
 */
function ogPreview(
  c: Context<Env>,
  host: string,
  slug: string,
  link: { name: string | null } | null,
) {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  const title = escapeHtml(link?.name ?? host)
  const url = escapeHtml(shortUrl(host, slug))
  c.header("cache-control", "no-store")
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8">` +
      `<title>${title}</title>` +
      `<meta property="og:type" content="website">` +
      `<meta property="og:title" content="${title}">` +
      `<meta property="og:url" content="${url}">` +
      `</head><body></body></html>`,
  )
}
