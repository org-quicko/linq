import type { Cache } from "./cache.ts"
import type { Caddy } from "./caddy.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db/client.ts"
import type { MetadataFetcher } from "./link-metadata.ts"

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
