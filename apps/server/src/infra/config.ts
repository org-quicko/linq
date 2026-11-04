import { join } from "node:path"
import { hostSchema, RESERVED_SLUGS } from "@linq/shared"
import { z } from "zod"

const clientBasePathSchema = z
  .string()
  .trim()
  .max(256)
  .regex(
    // A bare "/" is the root mount, allowed only with LINQ_APP_HOST (see below).
    /^\/(?:(?:[a-z0-9_-]{1,64})(?:\/[a-z0-9_-]{1,64})*)?$/,
    "must be / or start with /, contain lowercase path segments, and have no trailing slash",
  )
  .refine((path) => {
    const first = path.slice(1).split("/")[0]
    return first === "home" || !RESERVED_SLUGS.has(first)
  }, "first segment conflicts with a server route")

const postgresSchemaSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, "must be a lowercase PostgreSQL identifier")

/** The top-level slug claimed by the configured Client UI mount. */
export function clientBaseSegment(basePath: string): string {
  return basePath.slice(1).split("/")[0] ?? ""
}

/**
 * A path under the Client UI mount. A root mount has no prefix, so `/` + `/x`
 * must not become the protocol-relative `//x`.
 */
export function clientPath(basePath: string, path: string): string {
  return basePath === "/" ? path : `${basePath}${path}`
}

/**
 * Static server paths plus the deployment-specific Client UI mount. A root
 * mount claims no slug: it only ever answers on LINQ_APP_HOST, never on a
 * shortening domain.
 */
export function isReservedSlug(slug: string, clientBasePath: string): boolean {
  const normalised = slug.toLowerCase()
  const segment = clientBaseSegment(clientBasePath)
  return RESERVED_SLUGS.has(normalised) || (segment !== "" && normalised === segment)
}

/**
 * Whether a request's Host header names LINQ_APP_HOST, tried as sent and then
 * with its port stripped, the same way a domain row is matched.
 */
export function isAppHost(config: Pick<Config, "LINQ_APP_HOST">, hostHeader: string): boolean {
  if (!config.LINQ_APP_HOST) return false
  const host = hostHeader.trim().toLowerCase()
  return host === config.LINQ_APP_HOST || host.replace(/:\d+$/, "") === config.LINQ_APP_HOST
}

const schema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    /** PostgreSQL schema that owns linq's tables and migration journals. */
    LINQ_DB_SCHEMA: postgresSchemaSchema.default("public"),
    /**
     * Removed in 2.0, when Redis became the only cache. Still parsed so a 1.x
     * `.env` naming `memory` or `none` fails loudly instead of being ignored;
     * `redis` is accepted as a harmless leftover. See resources/docs/adr/0024.
     */
    LINQ_CACHE_BACKEND: z.string().optional(),
    /** Required, and required to be reachable at boot. See resources/docs/adr/0024. */
    LINQ_REDIS_URL: z.string().min(1, "LINQ_REDIS_URL is required"),
    /**
     * How long a cached lookup survives. A backstop for a write-through that
     * failed, not the mechanism that keeps entries fresh.
     */
    LINQ_CACHE_TTL: z.coerce.number().int().min(1).default(300),
    LINQ_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Requests one authenticated key may make in one minute, per process. */
    LINQ_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(1_000),
    /** Maximum visits allowed to wait on the database before analytics drops excess events. */
    LINQ_VISIT_MAX_PENDING: z.coerce.number().int().min(1).max(100_000).default(1_000),
    /**
     * Most visits written per INSERT. Batches only form from visits that queue
     * behind a running insert; at most LINQ_VISIT_MAX_PENDING. See resources/docs/adr/0022.
     */
    LINQ_VISIT_BATCH_SIZE: z.coerce.number().int().min(1).max(100_000).default(100),
    /** Where a combined deployment mounts its pre-built Client UI. */
    LINQ_CLIENT_BASE_PATH: clientBasePathSchema.default("/home"),
    /**
     * The one host that serves the Client UI. Set, the UI answers only here and
     * never on a shortening domain, which is what lets it mount at `/`. Unset,
     * the UI answers on every host at LINQ_CLIENT_BASE_PATH.
     */
    LINQ_APP_HOST: hostSchema.optional(),
    // Same hostSchema an API-created domain goes through: a scheme snuck in
    // here (e.g. LINQ_DEFAULT_DOMAIN=https://example.com) would otherwise be
    // stored verbatim and doubled up by shortUrl()'s own "https://".
    LINQ_DEFAULT_DOMAIN: hostSchema.optional(),
    LINQ_DATA_DIR: z.string().default("./data"),
    LINQ_SLUG_LENGTH: z.coerce.number().int().min(4).max(32).default(6),
    LINQ_LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    /** Left unset it defaults under LINQ_DATA_DIR; set to "" for stdout only. */
    LINQ_LOG_FILE: z.string().optional(),
    LINQ_LOG_MAX_SIZE: z.string().trim().min(1).default("20m"),
    LINQ_LOG_RETAIN: z.coerce.number().int().min(1).max(100).default(5),
    /**
     * Caddy's admin API, e.g. `http://caddy:2019`. Left unset, domains are
     * never synced anywhere — linq only ever writes the `domains` table.
     */
    LINQ_CADDY_ADMIN_URL: z.string().min(1).optional(),
    /** Where Caddy reverse-proxies a matched domain to. Required once the admin URL is set. */
    LINQ_CADDY_UPSTREAM: z.string().min(1).optional(),
    /**
     * Set to "false" to stop linq's server from fetching any destination's
     * <head> for a title/description/favicon. An enum of the two literal
     * strings, not `z.coerce.boolean()` — that coercion treats the
     * non-empty string "false" as truthy, which is exactly the footgun an
     * opt-out flag cannot afford. See resources/docs/adr/0014.
     */
    // Disabled by default: enabling this is an explicit trust in the deployment's egress policy.
    LINQ_FETCH_LINK_METADATA: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((c, ctx) => {
    // A 1.x deployment that chose the in-process store or no cache at all must
    // decide to run Redis, not be switched to it silently.
    if (c.LINQ_CACHE_BACKEND !== undefined && c.LINQ_CACHE_BACKEND !== "redis") {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_CACHE_BACKEND"],
        message:
          `"${c.LINQ_CACHE_BACKEND}" was removed in 2.0: linq now caches in Redis only. ` +
          "Set LINQ_REDIS_URL and delete LINQ_CACHE_BACKEND",
      })
    }
    if (c.LINQ_CADDY_ADMIN_URL && !c.LINQ_CADDY_UPSTREAM) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_CADDY_UPSTREAM"],
        message: "required when LINQ_CADDY_ADMIN_URL is set",
      })
    }
    // On a shortening domain every root path is a slug; only a dedicated app
    // host can give the UI the root.
    if (c.LINQ_CLIENT_BASE_PATH === "/" && !c.LINQ_APP_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_APP_HOST"],
        message: "required when LINQ_CLIENT_BASE_PATH is /",
      })
    }
    // A batch can never fill from a queue smaller than itself.
    if (c.LINQ_VISIT_BATCH_SIZE > c.LINQ_VISIT_MAX_PENDING) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_VISIT_BATCH_SIZE"],
        message: "must not exceed LINQ_VISIT_MAX_PENDING",
      })
    }
    // The UI would shadow every link on it.
    if (c.LINQ_APP_HOST && c.LINQ_DEFAULT_DOMAIN === c.LINQ_APP_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_DEFAULT_DOMAIN"],
        message: "must differ from LINQ_APP_HOST",
      })
    }
  })
  // The log file is the durable thing linq writes, so it lives under the data
  // volume.
  .transform(({ LINQ_CACHE_BACKEND: _removed, ...c }) => ({
    ...c,
    LINQ_LOG_FILE: c.LINQ_LOG_FILE ?? join(c.LINQ_DATA_DIR, "logs", "linq.log"),
  }))

export type Config = z.infer<typeof schema>

/** Parses process.env and exits the process on a bad configuration. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    // Stays on console: the logger is configured from what just failed to parse.
    console.error(`Invalid configuration:\n${issues}`)
    process.exit(1)
  }
  return parsed.data
}
