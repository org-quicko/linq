import { sql } from "kysely"
import { type Db, span } from "../libs/index.ts"
import { shortUrl } from "./LinkService.ts"

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
function escapeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\[/g, "\\[").replace(/\]/g, "\\]")
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
 * The catalogue of one domain's listed, live links. Alphabetical by display
 * name, tiebroken by id. A catalogue is not a feed: this order changes only
 * when its contents change, so it stays diff-friendly and a crawler's
 * conditional fetch remains meaningful.
 */
export function renderLlmsForDomain(db: Db, domainId: string, host: string): Promise<string> {
  return span(
    "llms.render",
    async () => {
      const now = new Date()
      const rows = await db
        .selectFrom("links")
        .select(["name", "slug", "destination"])
        .where("domain_id", "=", domainId)
        .where("status", "=", "active")
        .where("listed", "=", true)
        .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
        .orderBy(sql`coalesce(name, slug)`)
        .orderBy("id")
        .limit(MAX_LISTED + 1)
        .execute()

      const entries = rows.slice(0, MAX_LISTED).map((row) => ({
        name: row.name ?? row.slug,
        url: shortUrl(host, row.slug),
        destination: row.destination,
      }))
      return renderLlms(host, entries, rows.length > MAX_LISTED)
    },
    { in: { domain_id: domainId }, out: (markdown) => ({ bytes: markdown.length }) },
  )
}
