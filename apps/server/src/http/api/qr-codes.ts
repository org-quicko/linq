import {
  ApiError,
  type QrCode,
  qrCodeCreateSchema,
  qrCodeListQuerySchema,
  qrCodePatchSchema,
  uuidSchema,
} from "@linq/shared"
import { and, count, desc, eq, ilike, or, type SQL } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { assertCanEdit } from "../../auth/permissions.ts"
import type { Db } from "../../db/client.ts"
import { domains, links, qrCodes } from "../../db/schema.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { loadLink, shortUrl } from "./links.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type QrCodeRow = {
  qrCode: typeof qrCodes.$inferSelect
  linkName: string | null
  linkStatus: "active" | "archived"
  linkOwnerId: string | null
  slug: string
  domainHost: string
}

/** Maps a joined QR code row to the JSON shape the API returns. */
function toQrCode(row: QrCodeRow): QrCode {
  const { qrCode } = row
  return {
    id: qrCode.id,
    linkId: qrCode.linkId,
    name: qrCode.name,
    dotColor: qrCode.dotColor,
    bgColor: qrCode.bgColor,
    pattern: qrCode.pattern,
    linkName: row.linkName,
    linkStatus: row.linkStatus,
    linkOwnerId: row.linkOwnerId,
    slug: row.slug,
    domainHost: row.domainHost,
    shortUrl: shortUrl(row.domainHost, row.slug),
    createdAt: qrCode.createdAt.toISOString(),
    updatedAt: qrCode.updatedAt.toISOString(),
  }
}

/**
 * Inner joins only: `qr_codes.link_id` is NOT NULL behind a foreign key, and
 * `links.domain_id` the same, so neither join can ever drop a row. No
 * `leftJoin(apiKeys)` — that exists in `links.ts` only to resolve
 * `ownerName`, which a QR row does not carry (plans/Plan_31.md §A1).
 */
function qrCodeQuery(db: Db) {
  return db
    .select({
      qrCode: qrCodes,
      linkName: links.name,
      linkStatus: links.status,
      linkOwnerId: links.ownerId,
      slug: links.slug,
      domainHost: domains.host,
    })
    .from(qrCodes)
    .innerJoin(links, eq(links.id, qrCodes.linkId))
    .innerJoin(domains, eq(domains.id, links.domainId))
}

/** Loads one QR code as a complete API response, or throws 404. */
function fetchQrCode(db: Db, id: string): Promise<QrCode> {
  return span(
    "qrCode.fetch",
    async () => {
      const [row] = await qrCodeQuery(db).where(eq(qrCodes.id, id)).limit(1)
      if (!row) throw ApiError.notFound("QR code")
      return toQrCode(row)
    },
    { in: { qrCodeId: id } },
  )
}

/** The raw row plus its link, for a permission check that needs the link's `ownerId`. */
function loadQrCode(
  db: Db,
  id: string,
): Promise<{ qrCode: typeof qrCodes.$inferSelect; link: typeof links.$inferSelect }> {
  return span(
    "qrCode.load",
    async () => {
      const [row] = await db
        .select({ qrCode: qrCodes, link: links })
        .from(qrCodes)
        .innerJoin(links, eq(links.id, qrCodes.linkId))
        .where(eq(qrCodes.id, id))
        .limit(1)
      if (!row) throw ApiError.notFound("QR code")
      return row
    },
    { in: { qrCodeId: id } },
  )
}

/**
 * Mounted top-level (`/v1/qr-codes`), because the list view spans every link.
 * Permissions delegate entirely to the parent link (`can.editLink`) — see
 * plans/Plan_31.md §A3b for why there is no `can.editQrCode`.
 */
export const qrCodeRoutes = new Hono<Env>()
  .get("/", validate("query", qrCodeListQuerySchema), async (c) => {
    const q = c.req.valid("query")

    const filters: SQL[] = []
    if (q.linkId) filters.push(eq(qrCodes.linkId, q.linkId))
    if (q.search) {
      const term = `%${q.search}%`
      filters.push(
        or(ilike(qrCodes.name, term), ilike(links.name, term), ilike(links.slug, term)) as SQL,
      )
    }
    const where = filters.length ? and(...filters) : undefined

    const rows = await qrCodeQuery(c.var.db)
      .where(where)
      .orderBy(desc(qrCodes.createdAt), desc(qrCodes.id))
      .limit(q.limit)
      .offset(q.offset)

    // Repeats the join `links.ts` warns about: `search` filters on link
    // columns, so a count over the bare table would disagree with the page
    // it describes. The join cannot change the row count either way — `link_id`
    // is NOT NULL behind a foreign key.
    const [{ total }] = await c.var.db
      .select({ total: count() })
      .from(qrCodes)
      .innerJoin(links, eq(links.id, qrCodes.linkId))
      .where(where)

    return c.json({ data: rows.map(toQrCode), total, limit: q.limit, offset: q.offset })
  })

  .post("/", validate("json", qrCodeCreateSchema), async (c) => {
    const body = c.req.valid("json")
    // Unknown link first: a missing link is a 404, not a permission question.
    const link = await loadLink(c.var.db, body.linkId)
    assertCanEdit(c.var.principal, link.ownerId)
    if (link.status === "archived") {
      throw ApiError.conflict("cannot attach a QR code to an archived link")
    }

    const [row] = await c.var.db
      .insert(qrCodes)
      .values({
        id: Bun.randomUUIDv7(),
        linkId: body.linkId,
        name: body.name ?? null,
        dotColor: body.dotColor,
        bgColor: body.bgColor,
        pattern: body.pattern,
      })
      .returning()

    return c.json(await fetchQrCode(c.var.db, row.id), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchQrCode(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", qrCodePatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const { link } = await loadQrCode(c.var.db, id)
    assertCanEdit(c.var.principal, link.ownerId)

    // A blanket spread is safe here, unlike `links.ts`: every patchable field
    // is a string the column takes as-is, and the schema is strict.
    await c.var.db
      .update(qrCodes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(qrCodes.id, id))

    return c.json(await fetchQrCode(c.var.db, id))
  })

  /** Hard delete, no archive: a QR row has no slug and no redirect, so
   *  archiving it would be ceremony with no consequence. See docs/adr/0002's
   *  amendment. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    const { link } = await loadQrCode(c.var.db, id)
    assertCanEdit(c.var.principal, link.ownerId)

    await c.var.db.delete(qrCodes).where(eq(qrCodes.id, id))
    return c.body(null, 204)
  })
