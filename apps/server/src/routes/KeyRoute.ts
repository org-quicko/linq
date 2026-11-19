import { Hono } from "hono"
import { ApiKeyController } from "../controllers/index.ts"
import type { ApiKeyService } from "../services/index.ts"

/**
 * Builds the API key routes. Called once, by `createApp`.
 *
 * `keys`, mounted on `/keys`:
 * - GET    /     - list keys.
 * - POST   /     - mint a key.
 * - GET    /:id  - fetch a key.
 * - PATCH  /:id  - update a key.
 * - DELETE /:id  - revoke a key.
 *
 * `me`, mounted on `/me`:
 * - GET    /     - the calling key.
 *
 * @param apiKeyService - The app's one `ApiKeyService`.
 * @returns The `/keys` and `/me` sub-apps.
 */
export function keyRoutes(apiKeyService: ApiKeyService) {
  const apiKeyController = new ApiKeyController(apiKeyService)

  const keys = new Hono()
    .get("/", apiKeyController.list)
    .post("/", apiKeyController.create)
    .get("/:id", apiKeyController.get)
    .patch("/:id", apiKeyController.update)
    .delete("/:id", apiKeyController.delete)

  const me = new Hono().get("/", apiKeyController.me)

  return { keys, me }
}
