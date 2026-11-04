import { ApiError } from "@linq/shared"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import pkg from "../../package.json" with { type: "json" }
import { authenticate } from "../auth/middleware.ts"
import { limitByKey } from "../auth/rate-limit.ts"
import { type Cache, guarded, noCache } from "../infra/cache.ts"
import { type Caddy, guarded as guardedCaddy, noCaddy } from "../infra/caddy.ts"
import { type Config, isAppHost } from "../infra/config.ts"
import type { Db } from "../infra/db/client.ts"
import { guarded as guardedMetadata, type MetadataFetcher, noMetadata } from "../infra/link-metadata.ts"
import { reqLog, withRequestLog } from "../infra/log.ts"
import { mountAdmin } from "./admin-static.ts"
import { analyticsRoutes } from "../analytics/routes.ts"
import { domainRoutes } from "../domains/routes.ts"
import { keyRoutes, meRoutes } from "../keys/routes.ts"
import { linkRoutes, tagRoutes } from "../links/routes.ts"
import { mcpRoutes } from "../mcp/routes.ts"
import { qrCodeRoutes } from "../qr-codes/routes.ts"
import { ruleRoutes } from "../rules/routes.ts"
import { visitRoutes } from "../visits/routes.ts"
import type { Env } from "./env.ts"
import { llmsHandler } from "../redirect/llms.ts"
import { redirectHandler } from "../redirect/handler.ts"

export type AppDeps = {
  db: Db
  config: Config
  cache?: Cache
  caddy?: Caddy
  metadata?: MetadataFetcher
}

/**
 * Route order matters: everything linq answers itself is mounted before the
 * catch-all redirect handler, so a reserved path can never be shadowed.
 */
export function createApp({
  db,
  config,
  cache = noCache,
  caddy = noCaddy,
  metadata = noMetadata,
}: AppDeps) {
  const app = new Hono<Env>()
  // Wrapped here rather than at the Redis client, so no route can be broken by
  // a cache that is down, whichever implementation it was handed.
  const safeCache = guarded(cache)
  // Same reasoning: a domain mutation must succeed whether or not Caddy is
  // currently reachable.
  const safeCaddy = guardedCaddy(caddy)
  const safeMetadata = guardedMetadata(metadata)

  app.use("*", async (c, next) => {
    c.set("db", db)
    c.set("config", config)
    c.set("cache", safeCache)
    c.set("caddy", safeCaddy)
    c.set("metadata", safeMetadata)
    // The only global hook that sees both /api/* and redirect traffic, so the
    // request log cannot be ordered wrong.
    await withRequestLog(c, next)
  })

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.toBody(), err.status as ContentfulStatusCode)
    // The single place an error object is serialised: every span rethrows without
    // logging, so one failure produces one stack. Hono invokes this from inside
    // the composed handler chain, which still runs in the request's async scope,
    // so `reqLog()` carries the request id.
    reqLog().error({ err }, "unhandled error")
    return c.json(new ApiError("internal", "internal server error").toBody(), 500)
  })

  app.notFound((c) => c.json(ApiError.notFound("resource").toBody(), 404))

  // The Client UI may be served from another origin entirely: it stores a list of
  // servers and talks to whichever one is selected. That makes every call a
  // cross-origin one, and `Authorization` is never a simple header, so each is
  // preceded by a preflight OPTIONS that must be answered here. Open by design:
  // a key is still required, and no cookie is ever sent, so there is no ambient
  // authority for another origin to borrow.
  app.use("/api/*", cors())
  // API writes are small JSON documents; cap both declared and streamed bodies
  // before a validator or JSON parser can buffer an arbitrary payload.
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1_000_000,
      onError: (c) => c.json(ApiError.validation("request body exceeds 1 MB").toBody(), 413),
    }),
  )

  app.get("/api/health", (c) => c.json({ status: "ok", version: pkg.version }))

  // One limiter for REST and MCP alike, so a key has one budget per minute
  // whichever protocol it speaks.
  const limit = limitByKey(config.LINQ_API_RATE_LIMIT_PER_MINUTE)

  const v1 = new Hono<Env>()
  v1.use("*", authenticate, limit)
  v1.route("/analytics", analyticsRoutes)
  v1.route("/me", meRoutes)
  v1.route("/domains", domainRoutes)
  v1.route("/links", linkRoutes)
  v1.route("/links", ruleRoutes)
  v1.route("/qr-codes", qrCodeRoutes)
  v1.route("/visits", visitRoutes)
  v1.route("/tags", tagRoutes)
  v1.route("/keys", keyRoutes)
  app.route("/api/v1", v1)

  // Under /api, so it claims no slug: `api` is already reserved.
  const mcp = new Hono<Env>()
  mcp.use("*", authenticate, limit)
  mcp.route("/", mcpRoutes)
  app.route("/api/mcp", mcp)

  // `.on([...])`, not `.get()`: GET-only left HEAD falling through to the
  // catch-all's 404. Both text routes take the same fix.
  // The app host is nothing but the API and the UI, so none of it is for
  // crawlers. A root mount never answers on a shortening domain, so it gets no
  // line there.
  app.on(["GET", "HEAD"], "/robots.txt", (c) => {
    if (isAppHost(config, c.req.header("host") ?? new URL(c.req.url).host))
      return c.text("User-agent: *\nDisallow: /\n")
    const ui =
      config.LINQ_CLIENT_BASE_PATH === "/" ? "" : `Disallow: ${config.LINQ_CLIENT_BASE_PATH}\n`
    return c.text(`User-agent: *\nDisallow: /api\n${ui}`)
  })
  app.on(["GET", "HEAD"], "/llms.txt", ...llmsHandler)

  // The exported Client UI. Before the catch-all, or its first segment reads as a slug.
  mountAdmin(app, { basePath: config.LINQ_CLIENT_BASE_PATH })

  // Last: the catch-all redirect, so every reserved path above wins the match.
  app.on(["GET", "HEAD"], "/*", ...redirectHandler)

  return app
}

export type App = ReturnType<typeof createApp>
