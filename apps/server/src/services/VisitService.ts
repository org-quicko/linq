import type { VisitInput, VisitListQuery } from "@linq/shared"
import type { Db } from "../clients/index.ts"
import {
  VisitListQueryToVisitFilterQueryConverter,
  VisitRowToVisitConverter,
} from "../converters/index.ts"
import type { VisitPipeline } from "../telemetry/index.ts"
import { FilterUtil } from "../utils/index.ts"

/**
 * Visits: fire-and-forget recording on the redirect's hot path, and the raw
 * log's list. Recording goes through the app's `VisitPipeline`, which owns the
 * OpenTelemetry logger, the `visits`-table exporter and the inserts in flight.
 */
export class VisitService {
  private readonly visitListQueryToVisitFilterQueryConverter: VisitListQueryToVisitFilterQueryConverter
  private readonly visitRowToVisitConverter: VisitRowToVisitConverter

  /**
   * @param db - The database the raw log is read from.
   * @param visitPipeline - Writes each recorded visit to `visits`.
   */
  constructor(
    private readonly db: Db,
    private readonly visitPipeline: VisitPipeline,
  ) {
    this.visitListQueryToVisitFilterQueryConverter = new VisitListQueryToVisitFilterQueryConverter()
    this.visitRowToVisitConverter = new VisitRowToVisitConverter()
  }

  /**
   * Records one visit, written to `visits` immediately (see `VisitPipeline`).
   *
   * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
   * insert must never turn a working link into an error.
   *
   * @param visit - The visit, without its id or click time.
   */
  record(visit: VisitInput): void {
    this.visitPipeline.record(visit)
  }

  /**
   * Waits for every visit already handed to `record`, including any recorded
   * while it waits.
   */
  flush(): Promise<void> {
    return this.visitPipeline.flush()
  }

  /**
   * Lists the raw log, newest first.
   *
   * @param q - The validated `GET /visits` query: filters and page.
   * @returns One page of visits and the total matching the filters.
   */
  async list(q: VisitListQuery) {
    const filters = FilterUtil.visitFilters(
      this.visitListQueryToVisitFilterQueryConverter.convertFrom(q),
    )
    // Page through narrow index entries before fetching full visit rows. A
    // deep offset must not sort or fetch millions of user-agent/query objects.
    const page = this.db
      .selectFrom("visits")
      .select(["id", "visited_at"])
      .where((eb) => eb.and(filters))
      .orderBy("visited_at", "desc")
      .orderBy("id", "desc")
      .limit(q.limit)
      .offset(q.offset)
      .as("page")
    const rows = await this.db
      .selectFrom(page)
      .innerJoin("visits", "visits.id", "page.id")
      .selectAll("visits")
      .orderBy("page.visited_at", "desc")
      .orderBy("page.id", "desc")
      .execute()
    const { total } = await this.db
      .selectFrom("visits")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where((eb) => eb.and(filters))
      .executeTakeFirstOrThrow()
    return { data: rows.map((row) => this.visitRowToVisitConverter.convertFrom(row)), total }
  }
}
