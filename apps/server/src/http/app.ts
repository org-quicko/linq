import { ApiError } from "@linq/shared"
import { Hono } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import pkg from "../../package.json" with { type: "json" }
import { authenticate } from "../auth/middleware.ts"
import { type Geo, noGeo } from "../clicks/geo.ts"
import type { Config } from "../config.ts"
import type { Db } from "../db/client.ts"
import { reqLog, withRequestLog } from "../log.ts"
import { mountAdmin } from "./admin-static.ts"
import { clickRoutes } from "./api/clicks.ts"
import { domainRoutes } from "./api/domains.ts"
import { linkRoutes, tagRoutes } from "./api/links.ts"
import { meRoutes } from "./api/me.ts"
import { ruleRoutes } from "./api/rules.ts"
import { domainStatsRoutes, globalStatsRoutes, linkStatsRoutes } from "./api/stats.ts"
import { keyRoutes, userRoutes } from "./api/users.ts"
import type { Env } from "./env.ts"
import { redirectHandler } from "./redirect.ts"

export type AppDeps = { db: Db; config: Config; geo?: Geo }

/**
 * Route order matters: everything linq answers itself is mounted before the
 * catch-all redirect handler, so a reserved path can never be shadowed.
 */
export function createApp({ db, config, geo = noGeo }: AppDeps) {
  const app = new Hono<Env>()

  app.use("*", async (c, next) => {
    c.set("db", db)
    c.set("config", config)
    c.set("geo", geo)
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

  app.get("/api/health", (c) => c.json({ status: "ok", version: pkg.version }))

  const v1 = new Hono<Env>()
  v1.use("*", authenticate)
  v1.route("/me", meRoutes)
  v1.route("/domains", domainRoutes)
  v1.route("/domains", domainStatsRoutes)
  v1.route("/links", linkRoutes)
  v1.route("/links", ruleRoutes)
  v1.route("/links", clickRoutes)
  v1.route("/links", linkStatsRoutes)
  v1.route("/stats", globalStatsRoutes)
  v1.route("/tags", tagRoutes)
  v1.route("/users", userRoutes)
  v1.route("/keys", keyRoutes)
  app.route("/api/v1", v1)

  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /api\nDisallow: /admin\n"))

  // The exported Admin UI. Before the catch-all, or /admin reads as a slug.
  mountAdmin(app)

  // Last: the catch-all redirect, so every reserved path above wins the match.
  app.on(["GET", "HEAD"], "/*", ...redirectHandler)

  return app
}

export type App = ReturnType<typeof createApp>
