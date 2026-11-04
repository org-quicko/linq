import { domainCreateSchema, domainPatchSchema, paginationSchema, uuidSchema } from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../app/env.ts"
import { validate } from "../app/validate.ts"
import {
  archiveDomain,
  createDomain,
  getDomain,
  listDomains,
  purgeDomain,
  updateDomain,
} from "./service.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

export const domainRoutes = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) =>
    c.json(await listDomains(c.var, c.req.valid("query"))),
  )

  .post("/", validate("json", domainCreateSchema), async (c) =>
    c.json(await createDomain(c.var, c.var.principal, c.req.valid("json")), 201),
  )

  .get("/:id", idParam, async (c) => c.json(await getDomain(c.var, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", domainPatchSchema), async (c) =>
    c.json(await updateDomain(c.var, c.var.principal, c.req.valid("param").id, c.req.valid("json"))),
  )

  /** DELETE is an alias for archiving; domains are never dropped. See resources/docs/adr/0002. */
  .delete("/:id", idParam, async (c) =>
    c.json(await archiveDomain(c.var, c.var.principal, c.req.valid("param").id)),
  )

  .delete("/:id/purge", idParam, async (c) => {
    await purgeDomain(c.var, c.var.principal, c.req.valid("param").id)
    return c.body(null, 204)
  })
