import { Hono } from "hono"
import { LinkTreeController } from "../controllers/index.ts"
import type { LinkTreeService } from "../services/index.ts"

/**
 * Builds the Link Tree routes, mounted on `/link-trees`. Called once, by
 * `createApp`. Listing uses `GET /links?type=tree`, and archiving, restoring
 * and purging are the `/links` endpoints, since a Link Tree is a Link.
 *
 * - POST   /     - create a Link Tree.
 * - GET    /:id  - fetch a Link Tree with its Items.
 * - PATCH  /:id  - partially update a Link Tree.
 *
 * @param linkTreeService - The app's one `LinkTreeService`.
 * @returns The `/link-trees` sub-app.
 */
export function linkTreeRoutes(linkTreeService: LinkTreeService) {
  const linkTreeController = new LinkTreeController(linkTreeService)

  return new Hono()
    .post("/", linkTreeController.create)
    .get("/:id", linkTreeController.get)
    .patch("/:id", linkTreeController.update)
}
