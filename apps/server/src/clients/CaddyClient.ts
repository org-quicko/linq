/**
 * The raw calls linq makes to one Caddy admin API. Knows routes, not domains:
 * `AdminApiCaddyAdapter` maps a domain onto a route.
 */
export class CaddyClient {
  /**
   * @param adminUrl - LINQ_CADDY_ADMIN_URL.
   */
  constructor(private readonly adminUrl: string) {}

  /**
   * Appends one route to the HTTP server's route list.
   *
   * @param route - The route, as Caddy's JSON config takes it.
   * @throws When the admin API answers anything but success.
   */
  async addRoute(route: object): Promise<void> {
    const res = await fetch(`${this.adminUrl}/config/apps/http/servers/srv0/routes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(route),
    })
    if (!res.ok) throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
  }

  /**
   * Deletes the config object tagged with `@id`.
   *
   * @param id - The object's `@id`.
   * @throws When the admin API answers anything but success or 404.
   */
  async deleteById(id: string): Promise<void> {
    const res = await fetch(`${this.adminUrl}/id/${id}`, { method: "DELETE" })
    // 404 is the idempotent case — already gone — not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`caddy admin API ${res.status}: ${await res.text()}`)
    }
  }
}
