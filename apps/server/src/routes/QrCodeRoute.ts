import { Hono } from "hono"
import { QrCodeController } from "../controllers/index.ts"
import type { LinkService, QrCodeService } from "../services/index.ts"

/**
 * Builds the QR code routes, mounted on `/qr-codes`. Called once, by `createApp`.
 *
 * - GET    /     - list QR codes.
 * - POST   /     - create a QR code for a link.
 * - GET    /:id  - fetch a QR code.
 * - PATCH  /:id  - partially update a QR code.
 * - DELETE /:id  - delete a QR code.
 *
 * @param qrCodeService - The app's one `QrCodeService`.
 * @param linkService - The app's one `LinkService`.
 * @returns The `/qr-codes` sub-app.
 */
export function qrCodeRoutes(qrCodeService: QrCodeService, linkService: LinkService) {
  const qrCodeController = new QrCodeController(qrCodeService, linkService)

  return new Hono()
    .get("/", qrCodeController.list)
    .post("/", qrCodeController.create)
    .get("/:id", qrCodeController.get)
    .patch("/:id", qrCodeController.update)
    .delete("/:id", qrCodeController.delete)
}
