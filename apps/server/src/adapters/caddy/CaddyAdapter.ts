import type { Caddy } from "@linq/shared"
import type { Config } from "../../config.ts"
import { AdminApiCaddyAdapter } from "./AdminApiCaddyAdapter.ts"
import { NoopCaddyAdapter } from "./NoopCaddyAdapter.ts"

/** Opening the Caddy sync. */
export class CaddyAdapter {
  /**
   * Opens the admin-API adapter, or the no-op when LINQ_CADDY_ADMIN_URL is unset:
   * Caddy is optional. See resources/docs/adr/0012.
   *
   * @param config - LINQ_CADDY_ADMIN_URL and LINQ_CADDY_UPSTREAM.
   * @returns The adapter. Not guarded: `createApp` and `bootstrap` guard it at their seams.
   */
  static start(config: Pick<Config, "LINQ_CADDY_ADMIN_URL" | "LINQ_CADDY_UPSTREAM">): Caddy {
    return config.LINQ_CADDY_ADMIN_URL ? new AdminApiCaddyAdapter(config) : new NoopCaddyAdapter()
  }
}
