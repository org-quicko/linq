/**
 * Keeps Caddy's routes in sync with the `domains` table. Each domain is its
 * own route, addressed by the stable id `domain:<id>`, so one domain's sync
 * never touches another's. See resources/docs/adr/0012.
 */
export interface Caddy {
  upsert(domainId: string, host: string): Promise<void>
  remove(domainId: string): Promise<void>
}
