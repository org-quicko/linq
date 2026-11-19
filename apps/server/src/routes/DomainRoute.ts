import { Hono } from "hono"
import { DomainController } from "../controllers/index.ts"
import type { DomainService } from "../services/index.ts"

/**
 * Builds the domain routes, mounted on `/domains`. Called once, by `createApp`.
 *
 * - GET    /           - list domains.
 * - POST   /           - register a domain.
 * - GET    /:id        - fetch a domain.
 * - PATCH  /:id        - partially update a domain.
 * - DELETE /:id        - archive a domain.
 * - DELETE /:id/purge  - destroy an archived, empty domain.
 *
 * @param domainService - The app's one `DomainService`.
 * @returns The `/domains` sub-app.
 */
export function domainRoutes(domainService: DomainService) {
  const domainController = new DomainController(domainService)

  return new Hono()
    .get("/", domainController.list)
    .post("/", domainController.create)
    .get("/:id", domainController.get)
    .patch("/:id", domainController.update)
    .delete("/:id", domainController.archive)
    .delete("/:id/purge", domainController.purge)
}
