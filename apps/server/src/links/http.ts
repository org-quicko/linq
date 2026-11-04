import {
  linkCountQuerySchema,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
  uuidSchema,
} from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../http/env.ts"
import { validate } from "../http/validate.ts"
import {
  archiveLink,
  countLinks,
  createLink,
  getLink,
  listLinks,
  listTags,
  purgeArchivedLinks,
  purgeLink,
  updateLink,
} from "./service.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

export const linkRoutes = new Hono<Env>()
  .get("/", validate("query", linkListQuerySchema), async (c) =>
    c.json(await listLinks(c.var, c.req.valid("query"))),
  )

  /**
   * Registered ahead of `/:id` so "count" is never swallowed by that route's
   * uuid param. The client's sidebar badges are what this is for: reading
   * `total` off `GET /` would work too, but at the cost of fetching (and
   * joining across three tables for) a row neither badge displays.
   */
  .get("/count", validate("query", linkCountQuerySchema), async (c) =>
    c.json(await countLinks(c.var, c.req.valid("query"))),
  )

  .post("/", validate("json", linkCreateSchema), async (c) =>
    c.json(await createLink(c.var, c.var.principal, c.req.valid("json")), 201),
  )

  .get("/:id", idParam, async (c) => c.json(await getLink(c.var, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", linkPatchSchema), async (c) =>
    c.json(await updateLink(c.var, c.var.principal, c.req.valid("param").id, c.req.valid("json"))),
  )

  /** Registered ahead of `/:id` for the same reason as `/count` above. */
  .delete("/purge", async (c) => c.json(await purgeArchivedLinks(c.var, c.var.principal)))

  /** DELETE is an alias for archiving; links are never dropped. See resources/docs/adr/0002. */
  .delete("/:id", idParam, async (c) =>
    c.json(await archiveLink(c.var, c.var.principal, c.req.valid("param").id)),
  )

  .delete("/:id/purge", idParam, async (c) => {
    await purgeLink(c.var, c.var.principal, c.req.valid("param").id)
    return c.body(null, 204)
  })

export const tagRoutes = new Hono<Env>().get("/", async (c) => c.json(await listTags(c.var)))
