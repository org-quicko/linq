import type { Cache } from "./infra/cache.ts"
import type { Caddy } from "./infra/caddy.ts"
import type { Config } from "./infra/config.ts"
import type { Db } from "./infra/db/client.ts"
import type { MetadataFetcher } from "./infra/link-metadata.ts"

/**
 * What a service function is handed: the process-wide resources, never a
 * request. HTTP routes pass `c.var`, which carries exactly these plus the
 * principal; an MCP tool passes the same object. See resources/docs/adr/0023.
 */
export type Deps = {
  db: Db
  config: Config
  cache: Cache
  caddy: Caddy
  metadata: MetadataFetcher
}
