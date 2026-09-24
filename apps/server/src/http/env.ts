import type { Principal } from "../auth/middleware.ts"
import type { Cache } from "../cache.ts"
import type { Caddy } from "../caddy.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db/client.ts"
import type { MetadataFetcher } from "../link-metadata.ts"

/** Everything a route handler reads off the context. */
export type Env = {
  Variables: {
    db: Db
    config: Config
    cache: Cache
    caddy: Caddy
    metadata: MetadataFetcher
    /** Set by the auth middleware; only present under /api/v1. */
    principal: Principal
  }
}
