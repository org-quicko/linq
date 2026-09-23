import type { Db } from "../db/client.ts"
import { visits } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"

export type VisitInput = Omit<typeof visits.$inferInsert, "id" | "occurred_at">

/** In-flight inserts, so a shutdown or a test can wait for them. */
const pending = new Set<Promise<unknown>>()
let warnedAtCapacity = false

/**
 * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 */
export function recordVisit(db: Db, visit: VisitInput, maxPending: number): void {
  // Visits enrich analytics but must never let a traffic spike build an
  // unbounded database backlog or delay a redirect. Resume recording once the
  // backlog drains below the configured cap.
  if (pending.size >= maxPending) {
    if (!warnedAtCapacity) {
      warnedAtCapacity = true
      reqLog().warn({ maxPending }, "visit queue full; dropping analytics event")
    }
    return
  }

  const insert = span(
    "visit.record",
    () => db.insert(visits).values({ id: Bun.randomUUIDv7(), ...visit }),
    { in: { link_id: visit.link_id ?? null, domain_id: visit.domain_id, slug: visit.slug_requested } },
  )
    // `reqLog()` still resolves here: the insert is not awaited, but it starts
    // inside the redirect request's async scope, so a failure correlates to it.
    .catch((err) => reqLog().error({ err, link_id: visit.link_id ?? null }, "visit insert failed"))
    .finally(() => {
      pending.delete(insert)
      if (pending.size < maxPending) warnedAtCapacity = false
    })
  pending.add(insert)
}

/** Waits for every visit already handed to `recordVisit`. */
export async function flushVisits(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}
