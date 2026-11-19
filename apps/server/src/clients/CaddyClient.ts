import type { Caddy } from "@linq/shared"
import type { Config } from "../config.ts"
import { Log, Logger } from "../libs/index.ts"

/** A client bound to one Caddy admin API. */
export class CaddyClient implements Caddy {
  /**
   * @param adminUrl - LINQ_CADDY_ADMIN_URL.
   * @param upstream - LINQ_CADDY_UPSTREAM, where Caddy proxies each domain to.
   */
  constructor(
    private readonly adminUrl: string,
    private readonly upstream: string,
  ) {}

  /**
   * Opens a client for the configured admin API, or a no-op when none is
   * configured: Caddy is optional. Not guarded: `createApp` guards it at the seam.
   *
   * @param config - LINQ_CADDY_ADMIN_URL and LINQ_CADDY_UPSTREAM.
   * @returns The client.
   */
  static start(config: Pick<Config, "LINQ_CADDY_ADMIN_URL" | "LINQ_CADDY_UPSTREAM">): Caddy {
    if (!config.LINQ_CADDY_ADMIN_URL) return new NoopCaddyClient()
    // LINQ_CADDY_UPSTREAM is enforced by config's superRefine.
    return new CaddyClient(config.LINQ_CADDY_ADMIN_URL, config.LINQ_CADDY_UPSTREAM!)
  }

  @Log("caddy.upsert", { in: (domainId: string) => ({ domain_id: domainId }) })
  async upsert(domainId: string, host: string): Promise<void> {
    // Delete-then-add is what makes this idempotent without first
    // asking Caddy what it currently holds: a reactivated domain and a
    // brand-new one look identical to this call.
    await this.delete(domainId)
    const res = await fetch(`${this.adminUrl}/config/apps/http/servers/srv0/routes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "@id": `domain:${domainId}`,
        // Caddy's host matcher works on hostname only; a stored host may carry a port.
        match: [{ host: [host.split(":")[0]] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: this.upstream }] }],
      }),
    })
    if (!res.ok) throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
  }

  @Log("caddy.remove", { in: (domainId: string) => ({ domain_id: domainId }) })
  async remove(domainId: string): Promise<void> {
    return this.delete(domainId)
  }

  /**
   * Deletes one domain's route; shared by `remove` and `upsert`'s first step.
   *
   * @param domainId - id of the domain.
   * @throws When the admin API answers anything but success or 404.
   */
  private async delete(domainId: string): Promise<void> {
    const res = await fetch(`${this.adminUrl}/id/domain:${domainId}`, { method: "DELETE" })
    // 404 is the idempotent case — already gone — not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
    }
  }
}

/** What runs when Caddy sync is switched off — every install without LINQ_CADDY_ADMIN_URL. */
export class NoopCaddyClient implements Caddy {
  async upsert(_domainId: string, _host: string): Promise<void> {}

  async remove(_domainId: string): Promise<void> {}
}

/**
 * Makes a Caddy sync unable to fail its caller. A domain mutation must
 * succeed whether or not Caddy is currently reachable; the next successful
 * upsert or the next boot's `reconcileCaddy` repairs whatever this missed.
 */
export class GuardedCaddy implements Caddy {
  /**
   * @param caddy - The client to guard.
   */
  constructor(private readonly caddy: Caddy) {}

  async upsert(domainId: string, host: string): Promise<void> {
    try {
      await this.caddy.upsert(domainId, host)
    } catch (err) {
      Logger.forRequest().error({ err, domain_id: domainId }, "caddy upsert failed")
    }
  }

  async remove(domainId: string): Promise<void> {
    try {
      await this.caddy.remove(domainId)
    } catch (err) {
      Logger.forRequest().error({ err, domain_id: domainId }, "caddy remove failed")
    }
  }
}
