import { join } from "node:path"
import { hostSchema, RESERVED_SLUGS } from "@linq/shared"
import { z } from "zod"

const clientBasePathSchema = z
  .string()
  .trim()
  .max(256)
  .regex(
    /^\/(?:[a-z0-9_-]{1,64})(?:\/[a-z0-9_-]{1,64})*$/,
    "must start with /, contain lowercase path segments, and have no trailing slash",
  )
  .refine((path) => {
    const first = path.slice(1).split("/")[0]
    return first === "home" || !RESERVED_SLUGS.has(first)
  }, "first segment conflicts with a server route")

/** The top-level slug claimed by the configured Client UI mount. */
export function clientBaseSegment(basePath: string): string {
  return basePath.slice(1).split("/")[0] ?? ""
}

/** Static server paths plus the deployment-specific Client UI mount. */
export function isReservedSlug(slug: string, clientBasePath: string): boolean {
  const normalised = slug.toLowerCase()
  return RESERVED_SLUGS.has(normalised) || normalised === clientBaseSegment(clientBasePath)
}

const schema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    /**
     * Which store the redirect cache uses. Left unset it follows
     * `LINQ_REDIS_URL`: supplying a URL is what makes Redis expected to exist.
     * `none` turns caching off entirely. See docs/adr/0009.
     */
    LINQ_CACHE_BACKEND: z.enum(["memory", "redis", "none"]).optional(),
    /** Only read when the backend is `redis`, and then it must be reachable. */
    LINQ_REDIS_URL: z.string().min(1).optional(),
    /**
     * How long a cached lookup survives, on either backend. A backstop for an
     * invalidation that was missed, not the invalidation mechanism.
     */
    LINQ_CACHE_TTL: z.coerce.number().int().min(1).default(300),
    /**
     * How often the in-memory backend physically removes expired entries.
     * Expiry itself remains exact on read; Redis ignores this setting.
     */
    LINQ_CACHE_SWEEP_INTERVAL: z.coerce.number().int().min(1).max(3600).default(60),
    /**
     * Entries the in-memory backend holds before evicting the least recently
     * used. Redis cannot be capped by a client; use `maxmemory` in redis.conf.
     * Bounded above because lru-cache pre-allocates its index arrays to it.
     */
    LINQ_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    LINQ_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Requests one authenticated key may make in one minute, per process. */
    LINQ_API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(1_000),
    /** Maximum visit inserts allowed to wait on the database before analytics drops excess events. */
    LINQ_VISIT_MAX_PENDING: z.coerce.number().int().min(1).max(100_000).default(1_000),
    /** Where a combined deployment mounts its pre-built Client UI. */
    LINQ_CLIENT_BASE_PATH: clientBasePathSchema.default("/home"),
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
     * opt-out flag cannot afford. See docs/adr/0014.
     */
    // Disabled by default: enabling this is an explicit trust in the deployment's egress policy.
    LINQ_FETCH_LINK_METADATA: z.enum(["true", "false"]).default("false"),
  })
  // Naming redis without somewhere to reach it is the one combination that
  // cannot be resolved by a default, so it is rejected rather than guessed at.
  .superRefine((c, ctx) => {
    if (c.LINQ_CACHE_BACKEND === "redis" && !c.LINQ_REDIS_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_REDIS_URL"],
        message: "required when LINQ_CACHE_BACKEND is redis",
      })
    }
    if (c.LINQ_CADDY_ADMIN_URL && !c.LINQ_CADDY_UPSTREAM) {
      ctx.addIssue({
        code: "custom",
        path: ["LINQ_CADDY_UPSTREAM"],
        message: "required when LINQ_CADDY_ADMIN_URL is set",
      })
    }
  })
  // The log file is the durable thing linq writes, so it lives under the data
  // volume.
  .transform((c) => ({
    ...c,
    LINQ_LOG_FILE: c.LINQ_LOG_FILE ?? join(c.LINQ_DATA_DIR, "logs", "linq.log"),
    // Unset means "whichever one was configured": a Redis URL selects Redis,
    // and nothing at all selects the in-process store. An explicit setting
    // always wins, so a URL can be left in `.env` while trying the other one.
    LINQ_CACHE_BACKEND: c.LINQ_CACHE_BACKEND ?? (c.LINQ_REDIS_URL ? "redis" : "memory"),
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
