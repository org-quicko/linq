import { type Click, clickListQuerySchema, uuidSchema } from "@linq/shared"
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { clicks } from "../../db/schema.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { loadLinq } from "./linqs.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/** Maps a click row to the JSON shape the API returns. */
function toClick(row: typeof clicks.$inferSelect): Click {
  return {
    id: row.id,
    linqId: row.linqId,
    domainId: row.domainId,
    slugRequested: row.slugRequested,
    occurredAt: row.occurredAt.toISOString(),
    isBot: row.isBot,
    platform: row.platform,
    userAgent: row.userAgent,
    referer: row.referer,
    country: row.country,
    region: row.region,
    destination: row.destination,
    query: row.query,
  }
}

/**
 * The filters every click read shares: an inclusive `from`/`to` window and the
 * human/bot split. `bot=any`, and a stats query with no `bot` at all, add no
 * predicate.
 *
 * Exported so the stats endpoints apply exactly the same window semantics as
 * the raw log; a report and the rows behind it can never disagree.
 */
export function clickFilters(q: {
  from?: string
  to?: string
  bot?: "true" | "false" | "any"
}): SQL[] {
  const filters: SQL[] = []
  if (q.from) filters.push(gte(clicks.occurredAt, new Date(q.from)))
  if (q.to) filters.push(lte(clicks.occurredAt, new Date(q.to)))
  if (q.bot && q.bot !== "any") filters.push(eq(clicks.isBot, q.bot === "true"))
  return filters
}

/** Mounted on /linqs; serves the raw click log of one linq, newest first. */
export const clickRoutes = new Hono<Env>().get(
  "/:id/clicks",
  idParam,
  validate("query", clickListQuerySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const q = c.req.valid("query")
    // Load first, so an unknown linq is a 404 rather than an empty page.
    await loadLinq(c.var.db, id)

    const where = and(eq(clicks.linqId, id), ...clickFilters(q))
    const rows = await c.var.db
      .select()
      .from(clicks)
      .where(where)
      .orderBy(desc(clicks.occurredAt), desc(clicks.id))
      .limit(q.limit)
      .offset(q.offset)
    const [{ total }] = await c.var.db.select({ total: count() }).from(clicks).where(where)

    return c.json({ data: rows.map(toClick), total, limit: q.limit, offset: q.offset })
  },
)
