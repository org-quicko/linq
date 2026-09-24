import type { Config } from "./config.ts"
import type { Db } from "./db/client.ts"
import { reqLog, span } from "./log.ts"

/**
 * Keeps Caddy's routes in sync with the `domains` table. Each domain is its
 * own route, addressed by a stable id, so one domain's sync never touches
 * another's. See docs/adr/0012.
 */
export type Caddy = {
  upsert(domain_id: string, host: string): Promise<void>
  remove(domain_id: string): Promise<void>
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
    async upsert(domain_id, host) {
      try {
        await caddy.upsert(domain_id, host)
      } catch (err) {
        reqLog().error({ err, domain_id }, "caddy upsert failed")
      }
    },
    async remove(domain_id) {
      try {
        await caddy.remove(domain_id)
      } catch (err) {
        reqLog().error({ err, domain_id }, "caddy remove failed")
      }
    },
  }
}

/** Caddy's host matcher works on hostname only; a stored host may carry a port. */
function hostnameOf(host: string): string {
  return host.split(":")[0]
}

/** One domain, one route object, addressed by this id for its whole lifetime. */
function routeId(domain_id: string): string {
  return `domain:${domain_id}`
}

/** Opens a client bound to one Caddy admin API, or a no-op when none is configured. */
export function startCaddy(config: Config): Caddy {
  if (!config.LINQ_CADDY_ADMIN_URL) return noCaddy
  const adminUrl = config.LINQ_CADDY_ADMIN_URL
  const upstream = config.LINQ_CADDY_UPSTREAM! // enforced by config's superRefine

  async function remove(domain_id: string): Promise<void> {
    const res = await fetch(`${adminUrl}/id/${routeId(domain_id)}`, { method: "DELETE" })
    // 404 is the idempotent case — already gone — not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
    }
  }

  return {
    async upsert(domain_id, host) {
      await span(
        "caddy.upsert",
        async () => {
          // Delete-then-add is what makes this idempotent without first
          // asking Caddy what it currently holds: a reactivated domain and a
          // brand-new one look identical to this call.
          await remove(domain_id)
          const res = await fetch(`${adminUrl}/config/apps/http/servers/srv0/routes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              "@id": routeId(domain_id),
              match: [{ host: [hostnameOf(host)] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }],
            }),
          })
          if (!res.ok) throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
        },
        { in: { domain_id } },
      )
    },
    remove: (domain_id) => span("caddy.remove", () => remove(domain_id), { in: { domain_id } }),
  }
}

/**
 * Repairs Caddy's routes after Caddy's own restart wipes it back to its empty
 * skeleton. The only place a mutation reads every domain instead of one — a
 * boot-time cost, paid once, never per-request. LINQ_APP_HOST is no domain
 * row, so it gets its own fixed route here; changing it takes a restart.
 */
export async function reconcileCaddy(db: Db, caddy: Caddy, appHost?: string): Promise<void> {
  const rows = await db.selectFrom("domains").select(["id", "host"]).where("status", "=", "active").execute()
  for (const row of rows) await caddy.upsert(row.id, row.host)
  if (appHost) await caddy.upsert("app-host", appHost)
}
