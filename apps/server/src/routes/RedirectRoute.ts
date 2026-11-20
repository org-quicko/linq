import { Hono } from "hono"
import type { Config } from "../config.ts"
import { RedirectController } from "../controllers/index.ts"
import type { RedirectService, VisitService } from "../services/index.ts"

/**
 * Builds the catch-all redirect, mounted on `/` last, so every path linq
 * answers itself has already been claimed. Called once, by `createApp`.
 *
 * - GET|HEAD /*  - redirect a short link (or the root path).
 *
 * `.on([...])`, not `.get()`: GET-only left HEAD falling through to a 404.
 *
 * @param redirectService - The app's one `RedirectService`.
 * @param visitService - The app's one `VisitService`.
 * @param config - The Client UI's base path and LINQ_APP_HOST.
 * @returns The catch-all sub-app.
 */
export function redirectRoutes(
  redirectService: RedirectService,
  visitService: VisitService,
  config: Pick<Config, "LINQ_CLIENT_BASE_PATH" | "LINQ_APP_HOST">,
) {
  const redirectController = new RedirectController(redirectService, visitService, config)
  return new Hono().on(["GET", "HEAD"], "/*", redirectController.redirect)
}
