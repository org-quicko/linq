import { visitListQuerySchema } from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../libs/index.ts"
import { validate } from "../middleware/index.ts"
import { listVisits, visitFilters } from "../services/index.ts"

/** Mounted at /visits; the raw log, newest first. Single-valued filters are lifted to lists. */
export const visitRoute = new Hono<Env>().get(
  "/",
  validate("query", visitListQuerySchema),
  async (c) => {
    const q = c.req.valid("query")
    const filters = visitFilters({
      from: q.from,
      to: q.to,
      bot: q.bot,
      orphan: q.orphan,
      link_id: q.link_id ? [q.link_id] : [],
      domain_id: q.domain_id ? [q.domain_id] : [],
      platform: q.platform ? [q.platform] : [],
      os: q.os ? [q.os] : [],
      browser: q.browser ? [q.browser] : [],
      referer_host: [],
      utm_source: [],
      utm_medium: [],
      utm_campaign: [],
      utm_content: [],
      utm_term: [],
      device_type: [],
    })
    const { data, total } = await listVisits(c.var.db, filters, q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  },
)
