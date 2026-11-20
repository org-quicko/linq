import type { Caddy } from "@linq/shared"

/** What runs when Caddy sync is switched off — every install without LINQ_CADDY_ADMIN_URL. */
export class NoopCaddyAdapter implements Caddy {
  async upsert(_domainId: string, _host: string): Promise<void> {}

  async remove(_domainId: string): Promise<void> {}
}
