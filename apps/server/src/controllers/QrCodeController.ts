import { qrCodeCreateSchema, qrCodeListQuerySchema, qrCodePatchSchema } from "@linq/shared"
import type { Context } from "hono"
import { authorize, idParamSchema, parseRequest } from "../middleware/index.ts"
import type { LinkService, QrCodeService } from "../services/index.ts"

/**
 * HTTP layer for `/qr-codes`, mounted top-level because the list view spans
 * every link. Writes need `update Link`: there is no separate QR code permission.
 */
export class QrCodeController {
  /**
   * @param qrCodeService - QR code queries.
   * @param linkService - Loads the link a new QR code attaches to.
   */
  constructor(
    private readonly qrCodeService: QrCodeService,
    private readonly linkService: LinkService,
  ) {}

  /**
   * GET /qr-codes
   * Lists one filtered page of QR codes, newest first.
   *
   * @param c - Hono request context; accepts the `qrCodeListQuerySchema` query params.
   * @returns JSON `{ data, total, limit, offset }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  list = async (c: Context) => {
    const q = await parseRequest(c, "query", qrCodeListQuerySchema)
    const { data, total } = await this.qrCodeService.list(q)
    return c.json({ data, total, limit: q.limit, offset: q.offset })
  }

  /**
   * POST /qr-codes
   * Creates a QR code for a link. An unknown link is a 404 before it is a
   * permission question.
   *
   * @param c - Hono request context; expects a `qrCodeCreateSchema` JSON body.
   * @returns JSON response with the created QR code, 201.
   * @throws {HttpError} 400 if the body does not validate.
   * @throws {HttpError} 403 if the key may not update links.
   * @throws {HttpError} 404 if the link does not exist.
   * @throws {HttpError} 409 if the link is archived.
   */
  create = async (c: Context) => {
    const body = await parseRequest(c, "json", qrCodeCreateSchema)
    const link = await this.linkService.load(body.link_id)
    authorize(c.var.principal, "update", "Link")
    return c.json(await this.qrCodeService.create(link, body), 201)
  }

  /**
   * GET /qr-codes/:id
   * Fetches a single QR code.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the QR code.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 404 if no QR code matches the id.
   */
  get = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    return c.json(await this.qrCodeService.get(id))
  }

  /**
   * PATCH /qr-codes/:id
   * Partially updates a QR code's label or styling.
   *
   * @param c - Hono request context; expects an `id` route param and a `qrCodePatchSchema` JSON body.
   * @returns JSON response with the updated QR code.
   * @throws {HttpError} 400 if the id or body does not validate.
   * @throws {HttpError} 403 if the key may not update links.
   * @throws {HttpError} 404 if no QR code matches the id.
   */
  update = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    const patch = await parseRequest(c, "json", qrCodePatchSchema)
    await this.qrCodeService.load(id)
    authorize(c.var.principal, "update", "Link")
    return c.json(await this.qrCodeService.update(id, patch))
  }

  /**
   * DELETE /qr-codes/:id
   * Deletes a QR code for good.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns Empty 204 response.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not update links.
   * @throws {HttpError} 404 if no QR code matches the id.
   */
  delete = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    await this.qrCodeService.load(id)
    authorize(c.var.principal, "update", "Link")
    await this.qrCodeService.delete(id)
    return c.body(null, 204)
  }
}
