import type { Rule, rulesPutSchema } from "@linq/shared"
import type { Selectable } from "kysely"
import type { z } from "zod"
import type { Principal } from "../auth/middleware.ts"
import { assertCanEdit } from "../auth/permissions.ts"
import { targetKey } from "../cache.ts"
import type { DB } from "../db/types.generated.ts"
import type { Deps } from "../deps.ts"
import { loadLink } from "../links/service.ts"
import { listRules } from "./store.ts"

type RulesPut = z.infer<typeof rulesPutSchema>

/** Maps a rule row to the JSON shape the API returns. */
function toRule(row: Selectable<DB["rules"]>): Rule {
  return {
    id: row.id,
    link_id: row.link_id,
    position: row.position,
    destination: row.destination,
    conditions: row.conditions,
  }
}

export async function getLinkRules({ db }: Deps, linkId: string): Promise<Rule[]> {
  // Load first, so an unknown link is a 404 rather than an empty list.
  await loadLink(db, linkId)
  return (await listRules(db, linkId)).map(toRule)
}

/** Replaces the whole ordered set; the server owns `position`. */
export async function replaceLinkRules(
  { db, cache }: Deps,
  principal: Principal,
  linkId: string,
  input: RulesPut,
): Promise<Rule[]> {
  const link = await loadLink(db, linkId)
  assertCanEdit(principal)

  // One transaction: a failed insert must never leave the link with its old
  // rules deleted and no new ones in their place.
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom("rules").where("link_id", "=", linkId).execute()
    if (input.length === 0) return
    await tx.insertInto("rules").values(
      input.map((rule, position) => ({
        id: Bun.randomUUIDv7(),
        link_id: linkId,
        position,
        destination: rule.destination,
        conditions: JSON.stringify(rule.conditions),
      })),
    ).execute()
  })

  // The redirect caches a link's rules inside its target entry, so replacing
  // them has to clear it just as editing the link itself does.
  await cache.del(targetKey(link.domain_id, link.slug))
  return (await listRules(db, linkId)).map(toRule)
}
