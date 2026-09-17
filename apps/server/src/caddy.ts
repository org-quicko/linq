import { eq } from "drizzle-orm"
import type { Config } from "./config.ts"
import type { Db } from "./db/client.ts"
import { domains } from "./db/schema.ts"
import { reqLog, span } from "./log.ts"

/**
 * Keeps Caddy's routes in sync with the `domains` table. Each domain is its
 * own route, addressed by a stable id, so one domain's sync never touches
 * another's. See docs/adr/0012.
 */
export type Caddy = {
  upsert(domainId: string, host: string): Promise<void>
  remove(domainId: string): Promise<void>
}

/** What runs when Caddy sync is switched off — every install without LINQ_CADDY_ADMIN_URL. */
export const noCaddy: Caddy = { upsert: async () => {}, remove: async () => {} }

/**
 * Makes a Caddy sync unable to fail its caller. A domain mutation must
 * succeed whether or not Caddy is currently reachable; the next successful
 * upsert or the next boot's `reconcileCaddy` repairs whatever this missed.
 */
export function guarded(caddy: Caddy): Caddy {
  return {
    async upsert(domainId, host) {
      try {
        await caddy.upsert(domainId, host)
      } catch (err) {
        reqLog().error({ err, domainId }, "caddy upsert failed")
      }
    },
    async remove(domainId) {
      try {
        await caddy.remove(domainId)
      } catch (err) {
        reqLog().error({ err, domainId }, "caddy remove failed")
      }
    },
  }
}

/** Caddy's host matcher works on hostname only; a stored host may carry a port. */
function hostnameOf(host: string): string {
  return host.split(":")[0]
}

/** One domain, one route object, addressed by this id for its whole lifetime. */
function routeId(domainId: string): string {
  return `domain:${domainId}`
}

/** Opens a client bound to one Caddy admin API, or a no-op when none is configured. */
export function startCaddy(config: Config): Caddy {
  if (!config.LINQ_CADDY_ADMIN_URL) return noCaddy
  const adminUrl = config.LINQ_CADDY_ADMIN_URL
  const upstream = config.LINQ_CADDY_UPSTREAM! // enforced by config's superRefine

  async function remove(domainId: string): Promise<void> {
    const res = await fetch(`${adminUrl}/id/${routeId(domainId)}`, { method: "DELETE" })
    // 404 is the idempotent case — already gone — not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
    }
  }

  return {
    async upsert(domainId, host) {
      await span(
        "caddy.upsert",
        async () => {
          // Delete-then-add is what makes this idempotent without first
          // asking Caddy what it currently holds: a reactivated domain and a
          // brand-new one look identical to this call.
          await remove(domainId)
          const res = await fetch(`${adminUrl}/config/apps/http/servers/srv0/routes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              "@id": routeId(domainId),
              match: [{ host: [hostnameOf(host)] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
            }),
          })
          if (!res.ok) throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
        },
        { in: { domainId } },
      )
    },
    remove: (domainId) => span("caddy.remove", () => remove(domainId), { in: { domainId } }),
  }
}

/**
 * Repairs Caddy's routes after Caddy's own restart wipes it back to its empty
 * skeleton. The only place a mutation reads every domain instead of one — a
 * boot-time cost, paid once, never per-request.
 */
export async function reconcileCaddy(db: Db, caddy: Caddy): Promise<void> {
  const rows = await db
    .select({ id: domains.id, host: domains.host })
    .from(domains)
    .where(eq(domains.status, "active"))
  for (const row of rows) await caddy.upsert(row.id, row.host)
}
