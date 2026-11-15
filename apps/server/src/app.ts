import { ApiError } from "@linq/shared"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import pkg from "../package.json" with { type: "json" }
import { type Config, isAppHost } from "./config.ts"
import {
  type Cache,
  type Caddy,
  type Db,
  type Env,
  guardedCache,
  guardedCaddy,
  guardedMetadata,
  type MetadataFetcher,
  noCache,
  noCaddy,
  noMetadata,
  reqLog,
} from "./libs/index.ts"
import { authenticate, limitByKey, requestLogger } from "./middleware/index.ts"
import {
  analyticsRoute,
  domainRoute,
  keyRoute,
  linkRoute,
  llmsHandler,
  meRoute,
  mountAdmin,
  qrCodeRoute,
  redirectHandler,
  ruleRoute,
  tagRoute,
  visitRoute,
} from "./routes/index.ts"

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
  // Guarded here, at the seam, rather than inside any one implementation: no
  // route can be broken by a cache that is down, a Caddy that is unreachable,
  // or a destination that will not answer, whichever implementation was handed in.
  const safeCache = guardedCache(cache)
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
    await requestLogger(c, next)
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

  const v1 = new Hono<Env>()
  v1.use("*", authenticate, limitByKey(config.LINQ_API_RATE_LIMIT_PER_MINUTE))
  v1.route("/analytics", analyticsRoute)
  v1.route("/me", meRoute)
  v1.route("/domains", domainRoute)
  v1.route("/links", linkRoute)
  v1.route("/links", ruleRoute)
  v1.route("/qr-codes", qrCodeRoute)
  v1.route("/visits", visitRoute)
  v1.route("/tags", tagRoute)
  v1.route("/keys", keyRoute)
  app.route("/api/v1", v1)

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
