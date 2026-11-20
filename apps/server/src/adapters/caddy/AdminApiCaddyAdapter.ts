import type { Caddy } from "@linq/shared"
import { CaddyClient } from "../../clients/index.ts"
import type { Config } from "../../config.ts"
import { Log } from "../../libs/index.ts"

/**
 * The Caddy port over Caddy's admin API: each domain is one route, tagged with
 * the domain's id, that reverse-proxies its host to linq. See resources/docs/adr/0012.
 */
export class AdminApiCaddyAdapter implements Caddy {
  private readonly client: CaddyClient
  private readonly upstream: string

  /**
   * @param config - LINQ_CADDY_ADMIN_URL, and LINQ_CADDY_UPSTREAM, where Caddy proxies each domain to.
   * @throws When either is unset.
   */
  constructor(config: Pick<Config, "LINQ_CADDY_ADMIN_URL" | "LINQ_CADDY_UPSTREAM">) {
    // `loadConfig` already refuses an admin URL without an upstream; this only narrows the types.
    if (!config.LINQ_CADDY_ADMIN_URL || !config.LINQ_CADDY_UPSTREAM)
      throw new Error("LINQ_CADDY_ADMIN_URL and LINQ_CADDY_UPSTREAM are required for Caddy sync")
    this.client = new CaddyClient(config.LINQ_CADDY_ADMIN_URL)
    this.upstream = config.LINQ_CADDY_UPSTREAM
  }

  @Log("caddy.upsert", { in: (domainId: string) => ({ domain_id: domainId }) })
  async upsert(domainId: string, host: string): Promise<void> {
    const id = AdminApiCaddyAdapter.routeId(domainId)
    // Delete-then-add is what makes this idempotent without first
    // asking Caddy what it currently holds: a reactivated domain and a
    // brand-new one look identical to this call.
    await this.client.deleteById(id)
    await this.client.addRoute({
      "@id": id,
      // Caddy's host matcher works on hostname only; a stored host may carry a port.
      match: [{ host: [host.split(":")[0]] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: this.upstream }] }],
    })
  }

  @Log("caddy.remove", { in: (domainId: string) => ({ domain_id: domainId }) })
  async remove(domainId: string): Promise<void> {
    return this.client.deleteById(AdminApiCaddyAdapter.routeId(domainId))
  }

  /** The `@id` a domain's route is tagged with, so it can be found again. */
  private static routeId(domainId: string): string {
    return `domain:${domainId}`
  }
}
