import { join } from "node:path"
import { z } from "zod"

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
     * Entries the in-memory backend holds before evicting the least recently
     * used. Redis cannot be capped by a client; use `maxmemory` in redis.conf.
     * Bounded above because lru-cache pre-allocates its index arrays to it.
     */
    LINQ_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    LINQ_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LINQ_DEFAULT_DOMAIN: z.string().trim().min(1).optional(),
    LINQ_DATA_DIR: z.string().default("./data"),
    LINQ_SLUG_LENGTH: z.coerce.number().int().min(4).max(32).default(6),
    LINQ_LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
      .default("info"),
    /** Left unset it defaults under LINQ_DATA_DIR; set to "" for stdout only. */
    LINQ_LOG_FILE: z.string().optional(),
    LINQ_LOG_MAX_SIZE: z.string().trim().min(1).default("20m"),
    LINQ_LOG_RETAIN: z.coerce.number().int().min(1).max(100).default(5),
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
