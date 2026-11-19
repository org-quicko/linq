import { Hono } from "hono"
import type { Config } from "../config.ts"
import { LlmsController } from "../controllers/index.ts"
import type { LlmsService, RedirectService } from "../services/index.ts"

/**
 * Builds `/llms.txt`, mounted outside `/api/v1`. Called once, by `createApp`.
 *
 * - GET|HEAD /  - the requested domain's catalogue.
 *
 * @param llmsService - The app's one `LlmsService`.
 * @param redirectService - The app's one `RedirectService`.
 * @param config - LINQ_CACHE_TTL.
 * @returns The `/llms.txt` sub-app.
 */
export function llmsRoutes(
  llmsService: LlmsService,
  redirectService: RedirectService,
  config: Pick<Config, "LINQ_CACHE_TTL">,
) {
  const llmsController = new LlmsController(llmsService, redirectService, config)
  return new Hono().on(["GET", "HEAD"], "/", llmsController.get)
}
