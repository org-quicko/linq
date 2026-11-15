import {
  ApiError,
  qrCodeCreateSchema,
  qrCodeListQuerySchema,
  qrCodePatchSchema,
} from "@linq/shared"
import { Hono } from "hono"
import type { Env } from "../libs/index.ts"
import { assertCan, idParam, validate } from "../middleware/index.ts"
import {
  createQrCode,
  deleteQrCode,
  getQrCode,
  listQrCodes,
  loadLink,
  loadQrCode,
  updateQrCode,
} from "../services/index.ts"

/**
 * Mounted top-level (`/v1/qr-codes`), because the list view spans every link.
 * Writes need `update Link` — there is no separate QR code permission.
 */
export const qrCodeRoute = new Hono<Env>()
  .get("/", validate("query", qrCodeListQuerySchema), async (c) => {
    const q = c.req.valid("query")
    const { data, total } = await listQrCodes(c.var.db, q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  })

  .post("/", validate("json", qrCodeCreateSchema), async (c) => {
    const body = c.req.valid("json")
    // Unknown link first: a missing link is a 404, not a permission question.
    const link = await loadLink(c.var.db, body.link_id)
    assertCan(c.var.principal, "update", "Link")
    if (link.status === "archived")
      throw ApiError.conflict("cannot attach a QR code to an archived link")
    return c.json(await createQrCode(c.var.db, body), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await getQrCode(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", qrCodePatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    await loadQrCode(c.var.db, id)
    assertCan(c.var.principal, "update", "Link")
    return c.json(await updateQrCode(c.var.db, id, c.req.valid("json")))
  })

  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    await loadQrCode(c.var.db, id)
    assertCan(c.var.principal, "update", "Link")
    await deleteQrCode(c.var.db, id)
    return c.body(null, 204)
  })
