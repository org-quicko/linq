import { qrCodeCreateSchema, qrCodeListQuerySchema, qrCodePatchSchema, uuidSchema } from "@linq/shared"
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../app/env.ts"
import { validate } from "../app/validate.ts"
import { createQrCode, deleteQrCode, getQrCode, listQrCodes, updateQrCode } from "./service.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

/**
 * Mounted top-level (`/v1/qr-codes`), because the list view spans every link.
 * Permissions are `can.editLink` — there is no `can.editQrCode`.
 */
export const qrCodeRoutes = new Hono<Env>()
  .get("/", validate("query", qrCodeListQuerySchema), async (c) =>
    c.json(await listQrCodes(c.var, c.req.valid("query"))),
  )

  .post("/", validate("json", qrCodeCreateSchema), async (c) =>
    c.json(await createQrCode(c.var, c.var.principal, c.req.valid("json")), 201),
  )

  .get("/:id", idParam, async (c) => c.json(await getQrCode(c.var, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", qrCodePatchSchema), async (c) =>
    c.json(await updateQrCode(c.var, c.var.principal, c.req.valid("param").id, c.req.valid("json"))),
  )

  .delete("/:id", idParam, async (c) => {
    await deleteQrCode(c.var, c.var.principal, c.req.valid("param").id)
    return c.body(null, 204)
  })
