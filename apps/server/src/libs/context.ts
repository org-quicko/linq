import type { AppAbility, Claim } from "@linq/shared"
import type { Config } from "../config.ts"
import type { Cache } from "./cache.ts"
import type { Caddy } from "./caddy.ts"
import type { Db } from "./db.ts"
import type { MetadataFetcher } from "./linkMetadata.ts"

/** A key is the principal; its CASL ability is built once after authentication. */
export type Principal = { keyId: string; claims: Claim[]; ability: AppAbility; name: string }

/** Everything a route handler reads off the Hono context. */
export type Env = {
  Variables: {
    db: Db
    config: Config
    cache: Cache
    caddy: Caddy
    metadata: MetadataFetcher
    /** Set by the `authenticate` middleware; only present under /api/v1. */
    principal: Principal
  }
}
