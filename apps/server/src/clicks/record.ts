import type { Db } from "../db/client.ts"
import { clicks } from "../db/schema.ts"
import { reqLog, span } from "../log.ts"

export type ClickInput = Omit<typeof clicks.$inferInsert, "id" | "occurredAt">

/** In-flight inserts, so a shutdown or a test can wait for them. */
const pending = new Set<Promise<unknown>>()

/**
 * Fire-and-forget on purpose: a click must never delay a redirect, and a failed
 * insert must never turn a working link into an error.
 */
export function recordClick(db: Db, click: ClickInput): void {
  const insert = span(
    "click.record",
    () => db.insert(clicks).values({ id: Bun.randomUUIDv7(), ...click }),
    { in: { linkId: click.linkId ?? null, domainId: click.domainId, slug: click.slugRequested } },
  )
    // `reqLog()` still resolves here: the insert is not awaited, but it starts
    // inside the redirect request's async scope, so a failure correlates to it.
    .catch((err) => reqLog().error({ err, linkId: click.linkId ?? null }, "click insert failed"))
    .finally(() => pending.delete(insert))
  pending.add(insert)
}

/** Waits for every click already handed to `recordClick`. */
export async function flushClicks(): Promise<void> {
  while (pending.size) await Promise.all([...pending])
}
