import { keyCreateSchema, keyPatchSchema, paginationSchema, uuidSchema } from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../app/env.ts"
import { validate } from "../app/validate.ts"
import { createKey, getCallingKey, getKey, listKeys, revokeKey, updateKey } from "./service.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

export const keyRoutes = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) =>
    c.json(await listKeys(c.var, c.var.principal, c.req.valid("query"))),
  )
  .post("/", validate("json", keyCreateSchema), async (c) =>
    c.json(await createKey(c.var, c.var.principal, c.req.valid("json")), 201),
  )
  .get("/:id", idParam, async (c) => c.json(await getKey(c.var, c.var.principal, c.req.valid("param").id)))
  .patch("/:id", idParam, validate("json", keyPatchSchema), async (c) =>
    c.json(await updateKey(c.var, c.var.principal, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id", idParam, async (c) => {
    await revokeKey(c.var, c.var.principal, c.req.valid("param").id)
    return c.body(null, 204)
  })

export const meRoutes = new Hono<Env>().get("/", async (c) => c.json(await getCallingKey(c.var, c.var.principal)))
