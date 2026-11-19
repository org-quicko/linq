import type { Cache, LlmsEntry } from "@linq/shared"
import { sql } from "kysely"
import { CacheAdapter } from "../adapters/index.ts"
import type { Db } from "../clients/index.ts"
import { LinkRowToLlmsEntryConverter } from "../converters/index.ts"
import { Log } from "../libs/index.ts"
import { CacheKeyUtil, MarkdownUtil } from "../utils/index.ts"

/**
 * The llms.txt catalogue of one domain's listed, live links. See
 * resources/docs/adr/0013.
 */
export class LlmsService {
  private readonly linkRowToLlmsEntryConverter: LinkRowToLlmsEntryConverter

  /**
   * No llms.txt is improved by 50,000 entries, and this is an unauthenticated
   * endpoint whose response is built in memory. A constant, not config — one
   * fewer knob.
   */
  private static readonly MAX_LISTED = 500

  /**
   * @param db - The database.
   * @param cache - Holds each domain's rendered document; cleared by link writes.
   */
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
  ) {
    this.linkRowToLlmsEntryConverter = new LinkRowToLlmsEntryConverter()
  }

  /**
   * Renders the llms.txt document. Pure, so escaping, capping, ordering and the
   * empty case are unit-testable without a database or a request. Link targets
   * need no escaping: `shortUrl` is built from `hostSchema` and `SLUG_PATTERN`,
   * neither of which can produce `(`, `)` or whitespace.
   *
   * @param host - The domain the document describes.
   * @param entries - The links to list, already ordered and capped.
   * @param truncated - Whether more links exist than are listed.
   * @returns The markdown document.
   */
  static render(host: string, entries: LlmsEntry[], truncated: boolean): string {
    const lines = [
      `# ${host}`,
      "",
      `> Short links published on ${host}. Each entry is a redirect; the URL after the colon is where it leads.`,
      "",
      "## Links",
      "",
      ...entries.map(
        (e) =>
          `- [${MarkdownUtil.escapeMarkdownText(e.name)}](${e.url}): ${MarkdownUtil.escapeMarkdownText(e.destination)}`,
      ),
    ]
    if (truncated) lines.push("", `_Showing the first ${LlmsService.MAX_LISTED} links only._`)
    return `${lines.join("\n")}\n`
  }

  /**
   * One domain's catalogue, alphabetical by display name, tiebroken by id. A
   * catalogue is not a feed: this order changes only when its contents change,
   * so it stays diff-friendly and a crawler's conditional fetch remains
   * meaningful. The rendered string is cached as a whole, keyed by domain id: a
   * string has no `Date` problem, unlike a row array.
   *
   * @param domainId - The domain to list.
   * @param host - The domain's host, as requested.
   * @returns The rendered llms.txt.
   */
  async renderForDomain(domainId: string, host: string): Promise<string> {
    const markdown = await CacheAdapter.readThrough(
      this.cache,
      CacheKeyUtil.llmsKey(domainId),
      () => this.loadMarkdown(domainId, host),
    )
    return markdown ?? ""
  }

  @Log("llms.render", {
    in: (domainId: string) => ({ domain_id: domainId }),
    out: (markdown: string) => ({ bytes: markdown.length }),
  })
  private async loadMarkdown(domainId: string, host: string) {
    const now = new Date()
    const rows = await this.db
      .selectFrom("links")
      .select(["name", "slug", "destination"])
      .where("domain_id", "=", domainId)
      .where("status", "=", "active")
      .where("listed", "=", true)
      .where((eb) => eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]))
      .orderBy(sql`coalesce(name, slug)`)
      .orderBy("id")
      .limit(LlmsService.MAX_LISTED + 1)
      .execute()

    const entries = rows
      .slice(0, LlmsService.MAX_LISTED)
      .map((row) => this.linkRowToLlmsEntryConverter.convertFrom(row, host))
    return LlmsService.render(host, entries, rows.length > LlmsService.MAX_LISTED)
  }
}
