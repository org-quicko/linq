import { Hono } from "hono"
import { LinkController } from "../controllers/index.ts"
import type { LinkService } from "../services/index.ts"

/**
 * Builds the link routes. Called once, by `createApp`: the controller is
 * stateless past its constructor, so one serves every request.
 *
 * `links`, mounted on `/links`:
 * - GET    /           - list links.
 * - GET    /count      - count links.
 * - POST   /           - create a link.
 * - DELETE /purge      - destroy every archived link.
 * - GET    /:id        - fetch a link.
 * - PATCH  /:id        - partially update a link.
 * - DELETE /:id        - archive a link.
 * - DELETE /:id/purge  - destroy an archived link.
 * - GET    /:id/rules  - list a link's rules.
 * - PUT    /:id/rules  - replace a link's rules.
 *
 * `tags`, mounted on `/tags`:
 * - GET    /           - list tags in use on active links.
 *
 * `/count` and `/purge` are registered ahead of `/:id`, so neither word is
 * ever taken for an id.
 *
 * @param linkService - The app's one `LinkService`.
 * @returns The `/links` and `/tags` sub-apps.
 */
export function linkRoutes(linkService: LinkService) {
  const linkController = new LinkController(linkService)

  const links = new Hono()
    .get("/", linkController.list)
    .get("/count", linkController.count)
    .post("/", linkController.create)
    .delete("/purge", linkController.purgeArchived)
    .get("/:id", linkController.get)
    .patch("/:id", linkController.update)
    .delete("/:id", linkController.archive)
    .delete("/:id/purge", linkController.purge)
    .get("/:id/rules", linkController.listRules)
    .put("/:id/rules", linkController.replaceRules)

  const tags = new Hono().get("/", linkController.listTags)

  return { links, tags }
}
