import { type Condition, RESERVED_SLUGS } from "@linq/shared"
import { and, eq, inArray } from "drizzle-orm"
import type { Context } from "hono"
import { createFactory } from "hono/factory"
import { domainKey, targetKey } from "../cache.ts"
import type { Db } from "../db/client.ts"
import { domains, links } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"
import { matchRules } from "../rules/match.ts"
import { listRules } from "../rules/store.ts"
import { detectBot, detectBotLabel, isPreviewCrawler } from "../visits/bot.ts"
import { detectBrowser, detectOs, detectPlatform } from "../visits/platform.ts"
import { recordVisit } from "../visits/record.ts"
import { shortUrl } from "./api/links.ts"
import type { Env } from "./env.ts"

/** The part of a domain row the redirect needs. Null means no active domain. */
export type ResolvedDomain = { id: string; fallbackUrl: string | null }

/**
 * Everything one slug on one domain resolves to, rules included, so a cache hit
 * answers the whole redirect. Null means no active link, i.e. an orphan visit.
 */
export type ResolvedTarget = {
  linkId: string
  name: string | null
  destination: string
  forwardQuery: boolean
  presetParams: Record<string, string>
  rules: { destination: string; conditions: Condition[] }[]
}

/**
 * A domain row may carry a port or not. The host is tried exactly as sent first,
 * then with its port stripped, so one `links.example.com` row also answers
 * requests on a non-standard port while `localhost:3000` still matches verbatim.
 */
function findActiveDomain(db: Db, hostHeader: string): Promise<ResolvedDomain | null> {
  return span(
    "domain.findActive",
    async () => {
      const host = hostHeader.trim().toLowerCase()
      const bare = host.replace(/:\d+$/, "")
      const candidates = bare === host ? [host] : [host, bare]

      const rows = await db
        .select({ id: domains.id, host: domains.host, fallbackUrl: domains.fallbackUrl })
        .from(domains)
        .where(and(inArray(domains.host, candidates), eq(domains.status, "active")))

      const row = rows.find((r) => r.host === host) ?? rows[0] ?? null
      return row ? { id: row.id, fallbackUrl: row.fallbackUrl } : null
    },
    { in: { host: hostHeader }, out: (domain) => ({ domainId: domain?.id ?? null }) },
  )
}

/**
 * Looks up what a slug resolves to on one domain, rules included. Archived links
 * are invisible here.
 */
function findActiveTarget(db: Db, domainId: string, slug: string): Promise<ResolvedTarget | null> {
  return span(
    "link.findActive",
    async () => {
      const [row] = await db
        .select()
        .from(links)
        .where(and(eq(links.domainId, domainId), eq(links.slug, slug), eq(links.status, "active")))
        .limit(1)
      if (!row) return null
      // Rules ride inside the same entry: every hit that resolves reads them, so
      // caching the link without them would leave a query behind on the hot path.
      const ordered = await listRules(db, row.id)
      return {
        linkId: row.id,
        name: row.name,
        destination: row.destination,
        forwardQuery: row.forwardQuery,
        presetParams: row.presetParams,
        rules: ordered.map((r) => ({ destination: r.destination, conditions: r.conditions })),
      }
    },
    { in: { domainId, slug }, out: (target) => ({ linkId: target?.linkId ?? null }) },
  )
}

/**
 * Reads one key through the cache, falling back to `load` on a miss and writing
 * the answer back — a `null` answer included, so an unknown host or slug costs
 * one query per TTL rather than one per request.
 */
async function through<T>(
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

const factory = createFactory<Env>()

/**
 * `GET|HEAD /:slug` and `GET|HEAD /`. Mounted last so every path linq answers
 * itself has already been claimed. Steps follow plans/Plan_1.md.
 */
export const redirectHandler = factory.createHandlers(async (c) => {
  const url = new URL(c.req.url)
  const slug = url.pathname.slice(1)

  // 1. Reserved paths belong to the API, the Client UI and robots.txt. Matching on
  //    the first segment covers /api/v1/typo and /home/whatever too, so an
  //    unclaimed one 404s instead of becoming an orphan visit on the fallback.
  const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
  if (RESERVED_SLUGS.has(firstSegment)) return c.text("Not Found", 404)

  // 2. An unknown or archived domain is not ours to report on.
  const host = c.req.header("host") ?? url.host
  const domain = await through(c, domainKey(host), () => findActiveDomain(c.var.db, host))
  if (!domain) return c.text("Not Found", 404)

  // HEAD is answered exactly like GET but never tracked.
  const tracked = c.req.method === "GET"
  const userAgent = c.req.header("user-agent") ?? null
  const link = slug
    ? await through(c, targetKey(domain.id, slug), () =>
        findActiveTarget(c.var.db, domain.id, slug),
      )
    : null

  const visit = {
    domainId: domain.id,
    slugRequested: slug,
    isBot: detectBot(userAgent),
    platform: detectPlatform(userAgent),
    os: detectOs(userAgent),
    browser: detectBrowser(userAgent),
    botLabel: detectBotLabel(userAgent),
    userAgent,
    referer: c.req.header("referer") ?? null,
    query: queryMap(url.searchParams),
  }

  // 3. Root path, unknown slug or archived link: an orphan visit on a live domain.
  if (!link) {
    const destination = domain.fallbackUrl
    if (tracked) recordVisit(c.var.db, { ...visit, linkId: null, destination })
    if (!destination) return c.text("Not Found", 404)
    return isPreviewCrawler(userAgent)
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
  reqLog().debug({ linkId: link.linkId, matchedRule: ruled !== null }, "rules matched")

  // 6. `forwardQuery` is the link's switch for touching the outgoing query at
  //    all: off passes the destination through exactly as written, presets
  //    included. On, the incoming query merges in first and the link's own
  //    preset params then overwrite whatever is there — the destination's query
  //    and the forwarded one alike. This only ever affects where the browser is
  //    sent, never what gets recorded: the visit's own `query` field already
  //    carries whatever the caller sent, so baking it into `destination` too
  //    would double-count it and fragment one real destination into one bucket
  //    per distinct querystring. See plans/Plan_22.md.
  const sendTo = link.forwardQuery
    ? applyPresets(mergeQuery(chosen, url.searchParams), link.presetParams)
    : chosen

  // 8. Insert after the response is built, and never await it. Recorded as
  //    `chosen` — the Destination the link or rule actually names — not
  //    `sendTo`, which is a different, effectively unique string per click.
  if (tracked) recordVisit(c.var.db, { ...visit, linkId: link.linkId, destination: chosen })

  return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, link) : sendRedirect(c, sendTo)
})

/** 7. Always 302, never cached: the destination can change under a live slug. */
function sendRedirect(c: Context<Env>, destination: string) {
  c.header("cache-control", "no-store")
  return c.redirect(destination, 302)
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
