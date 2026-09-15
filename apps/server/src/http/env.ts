import type { Principal } from "../auth/middleware.ts"
import type { Geo } from "../clicks/geo.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db/client.ts"

/** Everything a route handler reads off the context. */
export type Env = {
  Bindings: {
    /** Bun's server handle, injected by main.ts so the redirect can read the peer address. */
    server?: { requestIP(req: Request): { address: string } | null }
  }
  Variables: {
    db: Db
    config: Config
    geo: Geo
    /** Set by the auth middleware; only present under /api/v1. */
    principal: Principal
  }
}
