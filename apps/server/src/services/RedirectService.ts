import type { Cache, ResolvedDomain, ResolvedTarget } from "@linq/shared"
import { CacheAdapter } from "../adapters/index.ts"
import {
  DomainRowToResolvedDomainConverter,
  LinkRowToResolvedTargetConverter,
  LinkTreeRowsToResolvedLinkTreeConverter,
} from "../converters/index.ts"
import type { Db } from "../db/index.ts"
import { Log } from "../libs/index.ts"
import { CacheKeyUtil, UrlUtil } from "../utils/index.ts"
import { LinkTreeService } from "./LinkTreeService.ts"
import { RuleService } from "./RuleService.ts"

/**
 * What the redirect hot path resolves: the domain a Host header names and the
 * target a slug names on it. Both read through the cache, negative answers
 * included, so a flood of 404s costs one query per TTL rather than one per request.
 */
export class RedirectService {
  private readonly domainRowToResolvedDomainConverter: DomainRowToResolvedDomainConverter
  private readonly linkRowToResolvedTargetConverter: LinkRowToResolvedTargetConverter
  private readonly linkTreeRowsToResolvedLinkTreeConverter: LinkTreeRowsToResolvedLinkTreeConverter

  /**
   * @param db - The database.
   * @param cache - Read through on every lookup; services that write clear it.
   */
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
  ) {
    this.domainRowToResolvedDomainConverter = new DomainRowToResolvedDomainConverter()
    this.linkRowToResolvedTargetConverter = new LinkRowToResolvedTargetConverter()
    this.linkTreeRowsToResolvedLinkTreeConverter = new LinkTreeRowsToResolvedLinkTreeConverter()
  }

  /**
   * The active domain a Host header names, port or not. Cached under
   * `domainKey`, which `llms.txt` reads too.
   *
   * @param hostHeader - The request's Host header, as sent.
   * @returns What the redirect needs from the domain, or null when none is active.
   */
  findActiveDomain(hostHeader: string): Promise<ResolvedDomain | null> {
    return CacheAdapter.readThrough(this.cache, CacheKeyUtil.domainKey(hostHeader), () =>
      this.loadActiveDomain(hostHeader),
    )
  }

  /**
   * Whether this host was ever registered as a domain at all, active or
   * archived. Used only to decide the root path's admin-UI fallback, which must
   * fire for a host nobody registered but never for an archived one — that stays
   * a 404 for everything, root path included, same as `findActiveDomain` already
   * guarantees for a slug. Deliberately uncached and only ever queried once
   * `findActiveDomain` has already missed, since it exists purely to cover the
   * rare "unclaimed root path" case, not the hot redirect path.
   *
   * @param hostHeader - The request's Host header, as sent.
   * @returns Whether any domain row, in any status, matches the host.
   */
  @Log("domain.hostHasAny", { in: (hostHeader: string) => ({ host: hostHeader }) })
  async hostHasAnyDomain(hostHeader: string): Promise<boolean> {
    const rows = await this.db
      .selectFrom("domains")
      .select("id")
      .where("host", "in", UrlUtil.candidateHosts(hostHeader))
      .limit(1)
      .execute()
    return rows.length > 0
  }

  /**
   * Looks up what a slug resolves to on one domain, rules included. Archived
   * links are invisible here. Cached under `targetKey`.
   *
   * @param domainId - The domain the slug was requested on.
   * @param slug - The requested slug.
   * @returns The cacheable target, or null when no active link has the slug.
   */
  findActiveTarget(domainId: string, slug: string): Promise<ResolvedTarget | null> {
    return CacheAdapter.readThrough(this.cache, CacheKeyUtil.targetKey(domainId, slug), () =>
      this.loadActiveTarget(domainId, slug),
    )
  }

  @Log("domain.findActive", {
    in: (hostHeader: string) => ({ host: hostHeader }),
    out: (domain: ResolvedDomain | null) => ({ domain_id: domain?.id ?? null }),
  })
  private async loadActiveDomain(hostHeader: string) {
    const hosts = UrlUtil.candidateHosts(hostHeader)
    const rows = await this.db
      .selectFrom("domains")
      .select(["id", "host", "fallback_url", "base_path_redirect", "invalid_short_url_redirect"])
      .where("host", "in", hosts)
      .where("status", "=", "active")
      .execute()

    const row = rows.find((r) => r.host === hosts[0]) ?? rows[0]
    return row ? this.domainRowToResolvedDomainConverter.convertFrom(row) : null
  }

  @Log("link.findActive", {
    in: (domainId: string, slug: string) => ({ domain_id: domainId, slug }),
    out: (target: ResolvedTarget | null) => ({ link_id: target?.link_id ?? null }),
  })
  private async loadActiveTarget(domainId: string, slug: string) {
    const row = await this.db
      .selectFrom("links")
      .selectAll()
      .where("domain_id", "=", domainId)
      .where("slug", "=", slug)
      .where("status", "=", "active")
      .limit(1)
      .executeTakeFirst()
    if (!row) return null
    // A Link Tree's whole page rides inside its entry, for the same reason
    // rules do below: a cached hit must answer without another query.
    if (row.type === "tree") {
      const { tree, items } = await LinkTreeService.pageRows(this.db, row.id)
      return this.linkRowToResolvedTargetConverter.convertFrom(
        row,
        [],
        this.linkTreeRowsToResolvedLinkTreeConverter.convertFrom(row, tree, items),
      )
    }
    // Rules ride inside the same entry: every hit that resolves reads them, so
    // caching the link without them would leave a query behind on the hot path.
    return this.linkRowToResolvedTargetConverter.convertFrom(
      row,
      await new RuleService(this.db).list(row.id),
    )
  }
}
