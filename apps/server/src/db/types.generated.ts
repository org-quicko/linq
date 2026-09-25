/**
 * Query types for the PostgreSQL schema. Regenerate with `bun run db:codegen`
 * after applying migrations to the local verification database.
 *
 * Keep the driver contract (JSON column shapes, bigint read as number) when
 * regenerating. Do not add DDL here: migrations own DDL.
 */
import type { ColumnType, Generated } from "kysely"

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>
// node-postgres sends a JS array as a Postgres array literal, not JSON, so a
// jsonb array column only accepts a JSON.stringify'd string on write. PGlite
// would accept the raw array, which is why tests alone cannot catch this.
// biome-ignore lint/suspicious/noExplicitAny: read shape is asserted by callers
type JsonArray = ColumnType<any, string, string>

export interface DB {
  api_keys: {
    id: Generated<string>
    name: string
    claims: JsonArray
    key_hash: string
    prefix: string
    expires_at: NullableTimestamp
    created_at: Timestamp
    updated_at: Timestamp
  }
  domains: {
    id: Generated<string>
    host: string
    fallback_url: string | null
    base_path_redirect: string | null
    invalid_short_url_redirect: string | null
    status: Generated<"active" | "archived">
    created_at: Timestamp
    updated_at: Timestamp
  }
  links: {
    id: Generated<string>
    domain_id: string
    slug: string
    destination: string
    name: string | null
    description: string | null
    icon_url: string | null
    tags: Generated<string[]>
    forward_query: Generated<boolean>
    preset_params: ColumnType<any, any, any>
    status: Generated<"active" | "archived">
    expires_at: NullableTimestamp
    listed: Generated<boolean>
    created_at: Timestamp
    updated_at: Timestamp
  }
  rules: {
    id: Generated<string>
    link_id: string
    position: number
    destination: string
    conditions: JsonArray
  }
  qr_codes: {
    id: Generated<string>
    link_id: string
    name: string | null
    dot_color: Generated<string>
    bg_color: Generated<string>
    pattern: Generated<"squares" | "rounded" | "dots">
    created_at: Timestamp
    updated_at: Timestamp
  }
  visits: {
    id: Generated<string>
    link_id: string | null
    domain_id: string
    slug_requested: string
    occurred_at: Generated<Date>
    is_bot: boolean
    bot_classification: "missing_user_agent" | "isbot_match" | "pattern_match" | "unknown" | null
    platform: "android" | "ios" | "desktop"
    os: string | null
    browser: string | null
    user_agent: string | null
    referer: string | null
    referer_host: ColumnType<string | null, never, never>
    destination: string | null
    query: ColumnType<
      Record<string, string[]> | null,
      Record<string, string[]> | null | undefined,
      Record<string, string[]> | null
    >
  }
  visit_days: {
    day: Date
    domain_id: string
    link_id: string | null
    dimension: "total" | "platform" | "os" | "browser" | "referer" | "destination" | "slug"
    value: string
    is_bot: boolean
    count: Generated<number>
  }
  visit_counts: {
    domain_id: string
    link_id: string | null
    human: Generated<number>
    bot: Generated<number>
    last_visit_at: Date | null
  }
}
