import { visitListQuerySchema } from "@linq/shared"
import type { Context } from "hono"
import { parseRequest } from "../middleware/index.ts"
import type { VisitService } from "../services/index.ts"

/** HTTP layer for `/visits`: the raw log. */
export class VisitController {
  /**
   * @param visitService - Visit recording and the raw log.
   */
  constructor(private readonly visitService: VisitService) {}

  /**
   * GET /visits
   * Lists one filtered page of the raw log, newest first.
   *
   * @param c - Hono request context; accepts the `visitListQuerySchema` query params.
   * @returns JSON `{ data, total, limit, offset }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  list = async (c: Context) => {
    const q = await parseRequest(c, "query", visitListQuerySchema)
    const { data, total } = await this.visitService.list(q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  }
}
