import type { Cache, Caddy, MetadataFetcher } from "@linq/shared"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import pkg from "../package.json" with { type: "json" }
import {
  GuardedCache,
  GuardedCaddy,
  GuardedLinkMetadata,
  NoopCacheAdapter,
  NoopCaddyAdapter,
  NoopLinkMetadataAdapter,
} from "./adapters/index.ts"
import type { Config } from "./config.ts"
import type { Db } from "./db/index.ts"
import { HttpError, Logger } from "./libs/index.ts"
import { authenticate, limitByKey, requestLogger } from "./middleware/index.ts"
import {
  analyticsRoutes,
  domainRoutes,
  keyRoutes,
  linkRoutes,
  llmsRoutes,
  mountAdmin,
  qrCodeRoutes,
  redirectRoutes,
  visitRoutes,
} from "./routes/index.ts"
import {
  AnalyticsService,
  ApiKeyService,
  DomainService,
  LinkService,
  LlmsService,
  QrCodeService,
  RedirectService,
  VisitService,
} from "./services/index.ts"
import type { VisitPipeline } from "./telemetry/index.ts"
import { UrlUtil } from "./utils/index.ts"

export type AppDeps = {
  db: Db
  config: Config
  /** Started and drained by the caller, which owns its lifecycle like the database's. */
  visitPipeline: VisitPipeline
  cache?: Cache
  caddy?: Caddy
  metadata?: MetadataFetcher
}

/**
 * Builds the app: every service and controller exactly once, with its
 * dependencies through the constructor, so one instance of each serves every
 * request.
 *
 * Route order matters: everything linq answers itself is mounted before the
 * catch-all redirect handler, so a reserved path can never be shadowed.
 *
 * @param deps - The database, config, the visit pipeline, and the cache, Caddy and link-metadata adapters; each adapter defaults to its no-op.
 * @returns The Hono app.
 */
export function createApp({
  db,
  config,
  visitPipeline,
  cache = new NoopCacheAdapter(),
  caddy = new NoopCaddyAdapter(),
  metadata = new NoopLinkMetadataAdapter(),
}: AppDeps) {
  const app = new Hono()
  // Guarded here, at the seam, rather than inside any one implementation: no
  // route can be broken by a cache that is down, a Caddy that is unreachable,
  // or a destination that will not answer, whichever implementation was handed in.
  const safeCache = new GuardedCache(cache)
  const safeCaddy = new GuardedCaddy(caddy)
  const safeMetadata = new GuardedLinkMetadata(metadata)

  const apiKeyService = new ApiKeyService(db)
  const linkService = new LinkService(db, safeCache, safeMetadata, config)
  const domainService = new DomainService(db, safeCache, safeCaddy, config)
  const qrCodeService = new QrCodeService(db)
  const visitService = new VisitService(db, visitPipeline)
  const analyticsService = new AnalyticsService(db)
  const redirectService = new RedirectService(db, safeCache)
  const llmsService = new LlmsService(db, safeCache)

  // The only global hook that sees both /api/* and redirect traffic, so the
  // request log cannot be ordered wrong.
  app.use("*", requestLogger(config.LINQ_CLIENT_BASE_PATH))

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      // Covers Hono's own HTTPExceptions too (a validator's malformed JSON, say):
      // `from` re-expresses a bare one in linq's envelope. Answered through
      // `c.newResponse` so headers set before the throw (Retry-After, CORS) survive.
      const res = HttpError.from(err).getResponse()
      return c.newResponse(res.body, res)
    }
    // The single place an error object is serialised: every logged operation rethrows without
    // logging, so one failure produces one stack. Hono invokes this from inside
    // the composed handler chain, which still runs in the request's async scope,
    // so `Logger.forRequest()` carries the request id.
    Logger.forRequest().error({ err }, "unhandled error")
    const res = new HttpError("internal", "internal server error").getResponse()
    return c.newResponse(res.body, res)
  })

  app.notFound((c) => c.json(HttpError.notFound("resource").body, 404))

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
      onError: (c) => c.json(HttpError.validation("request body exceeds 1 MB").body, 413),
    }),
  )

  app.get("/api/health", (c) => c.json({ status: "ok", version: pkg.version }))

  const { links, tags } = linkRoutes(linkService)
  const { keys, me } = keyRoutes(apiKeyService)

  const v1 = new Hono()
  v1.use("*", authenticate(apiKeyService), limitByKey(config.LINQ_API_RATE_LIMIT_PER_MINUTE))
  v1.route("/analytics", analyticsRoutes(analyticsService))
  v1.route("/me", me)
  v1.route("/domains", domainRoutes(domainService))
  v1.route("/links", links)
  v1.route("/qr-codes", qrCodeRoutes(qrCodeService, linkService))
  v1.route("/visits", visitRoutes(visitService))
  v1.route("/tags", tags)
  v1.route("/keys", keys)
  app.route("/api/v1", v1)

  // `.on([...])`, not `.get()`: GET-only left HEAD falling through to the
  // catch-all's 404. Both text routes take the same fix.
  // The app host is nothing but the API and the UI, so none of it is for
  // crawlers. A root mount never answers on a shortening domain, so it gets no
  // line there.
  app.on(["GET", "HEAD"], "/robots.txt", (c) => {
    if (UrlUtil.isAppHost(config, c.req.header("host") ?? new URL(c.req.url).host))
      return c.text("User-agent: *\nDisallow: /\n")
    const ui =
      config.LINQ_CLIENT_BASE_PATH === "/" ? "" : `Disallow: ${config.LINQ_CLIENT_BASE_PATH}\n`
    return c.text(`User-agent: *\nDisallow: /api\n${ui}`)
  })
  app.route("/llms.txt", llmsRoutes(llmsService, redirectService, config))

  // The exported Client UI. Before the catch-all, or its first segment reads as a slug.
  mountAdmin(app, { basePath: config.LINQ_CLIENT_BASE_PATH, config })

  // Last: the catch-all redirect, so every reserved path above wins the match.
  app.route("/", redirectRoutes(redirectService, visitService, config))

  return app
}
