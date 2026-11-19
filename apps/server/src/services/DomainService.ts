import type { Cache, Caddy, Domain, DomainCreateInput, DomainPatch } from "@linq/shared"
import { sql } from "kysely"
import type { Db } from "../clients/index.ts"
import type { Config } from "../config.ts"
import {
  DomainCreateInputToDomainInsertConverter,
  DomainJoinedRowToDomainConverter,
} from "../converters/index.ts"
import { HttpError, Log } from "../libs/index.ts"
import { CacheKeyUtil, UrlUtil } from "../utils/index.ts"

const domainCreateInputToDomainInsertConverter = new DomainCreateInputToDomainInsertConverter()
const domainJoinedRowToDomainConverter = new DomainJoinedRowToDomainConverter()

/**
 * Domains: listing, the archive lock, purge, and keeping Caddy's routes in
 * step. Owns the side effects of every write, clearing the host's cached domain
 * entry and syncing Caddy, so no caller can forget either.
 */
export class DomainService {
  /**
   * @param db - The database.
   * @param cache - Cleared on every write; the redirect reads domains through it.
   * @param caddy - Synced on every status change; a no-op unless Caddy is configured.
   * @param config - LINQ_APP_HOST, which can never be a domain and gets its own Caddy route.
   */
  constructor(
    private readonly db: Db,
    private readonly cache: Cache,
    private readonly caddy: Caddy,
    private readonly config: Pick<Config, "LINQ_APP_HOST">,
  ) {}

  /**
   * Loads one domain as a complete API response.
   *
   * @param id - id of the domain.
   * @returns The domain, with its link count.
   * @throws {HttpError} 404 if no domain matches the id.
   */
  @Log("domain.fetch", {
    in: (id: string) => ({ domain_id: id }),
    out: (domain: Domain) => ({ host: domain.host, status: domain.status }),
  })
  async get(id: string): Promise<Domain> {
    const row = await this.domainQuery().where("domains.id", "=", id).limit(1).executeTakeFirst()
    if (!row) throw HttpError.notFound("domain")
    return domainJoinedRowToDomainConverter.convertFrom(row)
  }

  /**
   * Lists one page of domains by host.
   *
   * @param page - The page to read.
   * @returns The page, and the total.
   */
  async list({ limit, offset }: { limit: number; offset: number }) {
    const rows = await this.domainQuery()
      .orderBy("domains.host")
      .limit(limit)
      .offset(offset)
      .execute()
    const { total = 0 } =
      (await this.db
        .selectFrom("domains")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .executeTakeFirst()) ?? {}
    return { data: rows.map(domainJoinedRowToDomainConverter.convertFrom), total }
  }

  /**
   * Registers a domain, then clears the negative entry a request to this host
   * left behind while it 404'd, and gives it a Caddy route.
   *
   * @param input - The validated create body.
   * @returns The created domain.
   * @throws {HttpError} 400 if the host is LINQ_APP_HOST.
   * @throws {HttpError} 409 if the host is already registered, archived or not.
   */
  async create(input: DomainCreateInput): Promise<Domain> {
    // The Client UI claims every path on the app host, so no link there could resolve.
    if (UrlUtil.isAppHost(this.config, input.host)) {
      throw HttpError.validation(`${input.host} is LINQ_APP_HOST and cannot be a domain`)
    }
    const row = await this.db
      .insertInto("domains")
      .values({
        id: Bun.randomUUIDv7(),
        ...domainCreateInputToDomainInsertConverter.convertFrom(input),
      })
      .onConflict((oc) => oc.column("host").doNothing())
      .returningAll()
      .executeTakeFirst()
    if (!row) throw HttpError.conflict(`domain ${input.host} already exists`)
    const domain = domainJoinedRowToDomainConverter.convertFrom({ ...row, link_count: 0 })
    await this.cache.del(CacheKeyUtil.domainKey(domain.host))
    await this.caddy.upsert(domain.id, domain.host)
    return domain
  }

  /**
   * Applies a patch. Archiving through a patch takes the same lock and link
   * check as `archive`; a redirect-only patch changes nothing Caddy needs to know.
   *
   * @param id - id of the domain.
   * @param patch - The validated patch body.
   * @returns The updated domain.
   * @throws {HttpError} 404 if no domain matches the id.
   * @throws {HttpError} 409 if archiving a domain that still has links.
   */
  async update(id: string, patch: DomainPatch): Promise<Domain> {
    const before = await this.get(id)
    await this.db.transaction().execute(async (tx) => {
      if (patch.status === "archived") await DomainService.assertNoLinks(tx, id)
      await tx
        .updateTable("domains")
        .set({ ...patch, updated_at: new Date() })
        .where("id", "=", id)
        .execute()
    })
    // The three redirect URLs are what the redirect handler reads out of the cached entry.
    await this.cache.del(CacheKeyUtil.domainKey(before.host))
    if (patch.status === "archived") await this.caddy.remove(id)
    else if (patch.status !== undefined) await this.caddy.upsert(id, before.host)
    return this.get(id)
  }

  /**
   * Archives a domain. The row is kept; domains are never dropped by DELETE.
   * See resources/docs/adr/0002.
   *
   * @param id - id of the domain.
   * @returns The archived domain.
   * @throws {HttpError} 404 if no domain matches the id.
   * @throws {HttpError} 409 if the domain still has links.
   */
  async archive(id: string): Promise<Domain> {
    const before = await this.get(id)
    await this.db.transaction().execute(async (tx) => {
      await DomainService.assertNoLinks(tx, id)
      await tx
        .updateTable("domains")
        .set({ status: "archived", updated_at: new Date() })
        .where("id", "=", id)
        .execute()
    })
    await this.cache.del(CacheKeyUtil.domainKey(before.host))
    await this.caddy.remove(id)
    return this.get(id)
  }

  /**
   * Destroys an archived, empty domain for good, and its visits with it.
   * See resources/docs/adr/0002.
   *
   * @param domain - The domain, as loaded before the call.
   * @throws {HttpError} 409 if the domain is not archived, or still has links.
   */
  async purge(domain: Domain): Promise<void> {
    if (domain.status !== "archived")
      throw HttpError.conflict("archive the domain before purging it")

    await this.db.transaction().execute(async (tx) => {
      await DomainService.assertNoLinks(tx, domain.id)
      try {
        await DomainService.deleteDomain(tx, domain)
      } catch (err) {
        // The pre-check above is for the message; `links.domain_id` is ON
        // DELETE RESTRICT, so Postgres is what actually guarantees this. A
        // link created between the two would otherwise surface as an
        // unhandled FK violation, which app.ts reports as a 500 — a worse
        // answer than the 409 the same request would have got a moment
        // earlier. Mapped here, not in app.onError, so a genuine referential
        // bug elsewhere in the app is never hidden behind this message.
        // SQLSTATE 23503 is read off `code`, not an `instanceof`, so it works the
        // same for node-postgres (production) and PGlite (tests).
        if ((err as { code?: unknown } | null)?.code === "23503") {
          throw HttpError.conflict("domain still has links; purge them first")
        }
        throw err
      }
    })
    await this.cache.del(CacheKeyUtil.domainKey(domain.host))
    // Defensive, not load-bearing: an archived domain's route is normally gone already.
    await this.caddy.remove(domain.id)
  }

  /**
   * Repairs Caddy's routes after Caddy's own restart wipes it back to its empty
   * skeleton. The only place a mutation reads every domain instead of one — a
   * boot-time cost, paid once, never per-request. LINQ_APP_HOST is no domain
   * row, so it gets its own fixed route here; changing it takes a restart.
   */
  async reconcileCaddy(): Promise<void> {
    const rows = await this.db
      .selectFrom("domains")
      .select(["id", "host"])
      .where("status", "=", "active")
      .execute()
    for (const row of rows) await this.caddy.upsert(row.id, row.host)
    if (this.config.LINQ_APP_HOST) await this.caddy.upsert("app-host", this.config.LINQ_APP_HOST)
  }

  /**
   * Links per domain, archived included: the number that must reach zero before
   * the domain may be archived or purged. See `assertNoLinks`.
   *
   * @returns The joined select, ready for a `where`.
   */
  private domainQuery() {
    const counts = this.db
      .selectFrom("links")
      .select(["domain_id", sql<number>`count(*)`.as("n")])
      .groupBy("domain_id")
      .as("link_counts")

    return this.db
      .selectFrom("domains")
      .leftJoin(counts, "link_counts.domain_id", "domains.id")
      .selectAll("domains")
      .select(sql<number>`coalesce(link_counts.n, 0)`.as("link_count"))
  }

  /**
   * A domain may be retired only when nothing points at it — archived links
   * included. Archiving stops the host serving and purging takes its visits
   * with it, and an archived link still owns its slug on that host
   * (resources/docs/adr/0002), so either operation would strand a row that has nowhere
   * to go. Purging the links is the only way through, by design.
   *
   * Called under a FOR UPDATE row lock on the domain, which conflicts with
   * `LinkService.create`'s FOR SHARE on the same row: that lock, not the
   * transaction alone (READ COMMITTED would not close the race), is what
   * serialises an archive against a concurrent link create. Do not simplify it away.
   *
   * @param tx - The transaction the check runs in.
   * @param domainId - id of the domain.
   * @throws {HttpError} 409 if the domain still has links.
   */
  @Log("domain.assertNoLinks", { in: (_tx: Db, domainId: string) => ({ domain_id: domainId }) })
  private static async assertNoLinks(tx: Db, domainId: string): Promise<void> {
    await tx.selectFrom("domains").select("id").where("id", "=", domainId).forUpdate().execute()
    const { n = 0 } =
      (await tx
        .selectFrom("links")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("domain_id", "=", domainId)
        .executeTakeFirst()) ?? {}
    if (n > 0) {
      throw HttpError.conflict(`domain still has ${n} link${n === 1 ? "" : "s"}; purge them first`)
    }
  }

  @Log("domain.purge", {
    in: (_tx: Db, domain: Domain) => ({ domain_id: domain.id, host: domain.host }),
  })
  private static async deleteDomain(tx: Db, domain: Domain) {
    return tx.deleteFrom("domains").where("id", "=", domain.id).execute()
  }
}
