import type { Caddy } from "@linq/shared"
import { Logger } from "../../libs/index.ts"

/**
 * Makes a Caddy sync unable to fail its caller. A domain mutation must
 * succeed whether or not Caddy is currently reachable; the next successful
 * upsert or the next boot's Caddy reconcile (`bootstrap`) repairs whatever this missed.
 */
export class GuardedCaddy implements Caddy {
  /**
   * @param caddy - The adapter to guard.
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
