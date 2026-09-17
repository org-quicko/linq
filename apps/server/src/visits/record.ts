import type { Db } from "../db/client.ts"
import { visits } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"

export type VisitInput = Omit<typeof visits.$inferInsert, "id" | "occurredAt">

/** In-flight inserts, so a shutdown or a test can wait for them. */
const pending = new Set<Promise<unknown>>()

/**
 * Fire-and-forget on purpose: a visit must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 */
export function recordVisit(db: Db, visit: VisitInput): void {
  const insert = span(
    "visit.record",
    () => db.insert(visits).values({ id: Bun.randomUUIDv7(), ...visit }),
    { in: { linkId: visit.linkId ?? null, domainId: visit.domainId, slug: visit.slugRequested } },
  )
    // `reqLog()` still resolves here: the insert is not awaited, but it starts
    // inside the redirect request's async scope, so a failure correlates to it.
    .catch((err) => reqLog().error({ err, linkId: visit.linkId ?? null }, "visit insert failed"))
    .finally(() => pending.delete(insert))
  pending.add(insert)
}

/** Waits for every visit already handed to `recordVisit`. */
export async function flushVisits(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}
