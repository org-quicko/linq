import { RESERVED_SLUGS } from "@linq/shared"
import { and, eq, inArray } from "drizzle-orm"
import type { Context } from "hono"
import { createFactory } from "hono/factory"
import { detectBot } from "../clicks/bot.ts"
import { detectPlatform } from "../clicks/platform.ts"
import { recordClick } from "../clicks/record.ts"
import type { Db } from "../db/client.ts"
import { domains, linqs } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"
import { matchRules } from "../rules/match.ts"
import { listRules } from "../rules/store.ts"
import type { Env } from "./env.ts"

/**
 * A domain row may carry a port or not. The host is tried exactly as sent first,
 * then with its port stripped, so one `links.example.com` row also answers
 * requests on a non-standard port while `localhost:3000` still matches verbatim.
 */
function findActiveDomain(db: Db, hostHeader: string) {
  return span(
    "domain.findActive",
    async () => {
      const host = hostHeader.trim().toLowerCase()
      const bare = host.replace(/:\d+$/, "")
      const candidates = bare === host ? [host] : [host, bare]

      const rows = await db
        .select()
        .from(domains)
        .where(and(inArray(domains.host, candidates), eq(domains.status, "active")))

      return rows.find((row) => row.host === host) ?? rows[0] ?? null
    },
    {
      in: { host: hostHeader },
      out: (domain) => ({ domainId: domain?.id ?? null, host: domain?.host ?? null }),
    },
  )
}

/** Looks up the linq a slug points at on one domain. Archived linqs are invisible here. */
function findActiveLinq(db: Db, domainId: string, slug: string) {
  return span(
    "linq.findActive",
    async () => {
      const [row] = await db
        .select()
        .from(linqs)
        .where(and(eq(linqs.domainId, domainId), eq(linqs.slug, slug), eq(linqs.status, "active")))
        .limit(1)
      return row ?? null
    },
    { in: { domainId, slug }, out: (linq) => ({ linqId: linq?.id ?? null }) },
  )
}

/**
 * Incoming parameters win per key, and repeats survive: every key the caller
 * sent replaces the destination's copy of that key entirely.
 */
export function mergeQuery(destination: string, incoming: URLSearchParams): string {
  const url = new URL(destination)
  for (const key of new Set(incoming.keys())) url.searchParams.delete(key)
  for (const [key, value] of incoming) url.searchParams.append(key, value)
  return url.toString()
}

/** The click's record of what the caller asked for, before any merging. */
export function queryMap(params: URLSearchParams): Record<string, string[]> | null {
  const out: Record<string, string[]> = {}
  for (const [key, value] of params) {
    const seen = out[key]
    if (seen) seen.push(value)
    else out[key] = [value]
  }
  return Object.keys(out).length ? out : null
}

/** Never stored: the address is used for geo lookup and then dropped. See docs/adr/0001. */
function clientIp(c: Context<Env>): string | null {
  if (c.var.config.LINQ_TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")
    if (forwarded) return forwarded.split(",")[0]?.trim() || null
  }
  return c.env?.server?.requestIP(c.req.raw)?.address ?? null
}

const factory = createFactory<Env>()

/**
 * `GET|HEAD /:slug` and `GET|HEAD /`. Mounted last so every path linq answers
 * itself has already been claimed. Steps follow plans/Plan_1.md.
 */
export const redirectHandler = factory.createHandlers(async (c) => {
  const url = new URL(c.req.url)
  const slug = url.pathname.slice(1)

  // 1. Reserved paths belong to the API, the Admin UI and robots.txt. Matching on
  //    the first segment covers /api/v1/typo and /admin/whatever too, so an
  //    unclaimed one 404s instead of becoming an orphan click on the fallback.
  const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
  if (RESERVED_SLUGS.has(firstSegment)) return c.text("Not Found", 404)

  // 2. An unknown or archived domain is not ours to report on.
  const domain = await findActiveDomain(c.var.db, c.req.header("host") ?? url.host)
  if (!domain) return c.text("Not Found", 404)

  // HEAD is answered exactly like GET but never tracked.
  const tracked = c.req.method === "GET"
  const userAgent = c.req.header("user-agent") ?? null
  const linq = slug ? await findActiveLinq(c.var.db, domain.id, slug) : null

  const click = {
    domainId: domain.id,
    slugRequested: slug,
    isBot: detectBot(userAgent),
    platform: detectPlatform(userAgent),
    userAgent,
    referer: c.req.header("referer") ?? null,
    query: queryMap(url.searchParams),
    ...c.var.geo.lookup(clientIp(c)),
  }

  // 3. Root path, unknown slug or archived linq: an orphan click on a live domain.
  if (!linq) {
    const destination = domain.fallbackUrl
    if (tracked) recordClick(c.var.db, { ...click, linqId: null, destination })
    if (!destination) return c.text("Not Found", 404)
    return sendRedirect(c, destination)
  }

  // 4-5. Build the match context, then let the first rule whose conditions all
  //      hold supply the destination. No match falls back to the linq default.
  const ruled = matchRules(await listRules(c.var.db, linq.id), {
    platform: click.platform,
    query: url.searchParams,
    country: click.country,
  })
  const chosen = ruled ?? linq.destination
  // `matchRules` is synchronous and on the hot path, so it gets one line rather
  // than a span; which branch won is the only part worth recording.
  reqLog().debug({ linqId: linq.id, matchedRule: ruled !== null }, "rules matched")

  // 6. Forward the incoming query when the linq asks for it.
  const destination = linq.forwardQuery ? mergeQuery(chosen, url.searchParams) : chosen

  // 8. Insert after the response is built, and never await it.
  if (tracked) recordClick(c.var.db, { ...click, linqId: linq.id, destination })

  return sendRedirect(c, destination)
})

/** 7. Always 302, never cached: the destination can change under a live slug. */
function sendRedirect(c: Context<Env>, destination: string) {
  c.header("cache-control", "no-store")
  return c.redirect(destination, 302)
}
