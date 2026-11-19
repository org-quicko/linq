import { Hono } from "hono"
import { VisitController } from "../controllers/index.ts"
import type { VisitService } from "../services/index.ts"

/**
 * Builds the visit routes, mounted on `/visits`. Called once, by `createApp`.
 *
 * - GET    /  - list the raw log, newest first.
 *
 * @param visitService - The app's one `VisitService`.
 * @returns The `/visits` sub-app.
 */
export function visitRoutes(visitService: VisitService) {
  const visitController = new VisitController(visitService)
  return new Hono().get("/", visitController.list)
}
