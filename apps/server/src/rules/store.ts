import { asc, eq } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { rules } from "../db/schema.ts"
import { span } from "../log.ts"

/**
 * Reads every rule of one link in `position` order.
 *
 * The ordering is the contract `matchRules` relies on for first-match-wins, so
 * it lives here rather than in a route: the redirect and the API read rules the
 * same way.
 */
export function listRules(db: Db, link_id: string) {
  return span(
    "rules.list",
    () => db.select().from(rules).where(eq(rules.link_id, link_id)).orderBy(asc(rules.position)),
    { in: { link_id }, out: (rows) => ({ count: rows.length }) },
  )
}
