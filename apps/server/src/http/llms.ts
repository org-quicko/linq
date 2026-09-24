import { sql } from "kysely"
import { createFactory } from "hono/factory"
import { domainKey, llmsKey } from "../cache.ts"
import type { Db } from "../db/client.ts"
import { span } from "../log.ts"
import { shortUrl } from "./api/links.ts"
import type { Env } from "./env.ts"
import { findActiveDomain, through } from "./redirect.ts"

/**
 * No llms.txt is improved by 50,000 entries, and this is an unauthenticated
 * endpoint whose response is built in memory. A module constant, not config —
 * one fewer knob.
 */
const MAX_LISTED = 500

export type LlmsEntry = { name: string; url: string; destination: string }

/**
 * Collapses whitespace to a single space and escapes the two characters that
 * would break a markdown link label. The target URL needs no escaping:
 * `shortUrl` is built from `hostSchema` and `SLUG_PATTERN`, neither of which
 * can produce `(`, `)` or whitespace.
 */
function escapeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/\[/g, "\\[").replace(/\]/g, "\\]")
}

/**
 * Renders the llms.txt document. Pure, so escaping, capping, ordering and the
 * empty case are unit-testable without a database or a request.
 */
export function renderLlms(host: string, entries: LlmsEntry[], truncated: boolean): string {
  const lines = [
    `# ${host}`,
    "",
    `> Short links published on ${host}. Each entry is a redirect; the URL after the colon is where it leads.`,
    "",
    "## Links",
    "",
    ...entries.map((e) => `- [${escapeText(e.name)}](${e.url}): ${escapeText(e.destination)}`),
  ]
  if (truncated) lines.push("", `_Showing the first ${MAX_LISTED} links only._`)
  return `${lines.join("\n")}\n`
}

/**
 * Alphabetical by display name, tiebroken by id. A catalogue is not a feed:
 * this order changes only when its contents change, so it stays diff-friendly
 * and a crawler's conditional fetch remains meaningful.
 */
async function renderForDomain(db: Db, domain_id: string, host: string): Promise<string> {
  return span(
    "llms.render",
    async () => {
      const now = new Date()
      const rows = await db
        .selectFrom("links")
        .select(["name", "slug", "destination"])
        .where("domain_id", "=", domain_id)
        .where("status", "=", "active")
        .where("listed", "=", true)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
        .orderBy(sql`coalesce(name, slug)`)
        .orderBy("id")
        .limit(MAX_LISTED + 1)
        .execute()

      const truncated = rows.length > MAX_LISTED
      const entries: LlmsEntry[] = rows.slice(0, MAX_LISTED).map((r) => ({
        name: r.name ?? r.slug,
        url: shortUrl(host, r.slug),
        destination: r.destination,
      }))
      return renderLlms(host, entries, truncated)
    },
    { in: { domain_id }, out: (md) => ({ bytes: md.length }) },
  )
}

const factory = createFactory<Env>()

/**
 * `GET|HEAD /llms.txt`. No auth, by design: the route sits outside `/api/v1`,
 * which is the whole point, and also the reason `listed` defaults to false.
 */
export const llmsHandler = factory.createHandlers(async (c) => {
  const host = c.req.header("host") ?? new URL(c.req.url).host
  // Reads the same `domainKey` entry the redirect warms, so a live instance
  // pays zero extra queries for this route.
  const domain = await through(c, domainKey(host), () => findActiveDomain(c.var.db, host))
  if (!domain) return c.text("Not Found", 404)

  // The rendered string is cached as a whole, keyed by domain id: a string has
  // no `Date` problem, unlike a row array — see redirect.ts's `expired`.
  const md = await through(c, llmsKey(domain.id), () => renderForDomain(c.var.db, domain.id, host))

  return c.body(md ?? "", 200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": `public, max-age=${c.var.config.LINQ_CACHE_TTL}`,
  })
})
