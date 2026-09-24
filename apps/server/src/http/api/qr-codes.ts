import {
  ApiError,
  type QrCode,
  qrCodeCreateSchema,
  qrCodeListQuerySchema,
  qrCodePatchSchema,
  uuidSchema,
} from "@linq/shared"
import { type Selectable } from "kysely"
import { Hono } from "hono"
import { z } from "zod"
import { assertCanEdit } from "../../auth/permissions.ts"
import type { Db } from "../../db/client.ts"
import type { DB } from "../../db/types.generated.ts"
import { span } from "../../log.ts"
import type { Env } from "../env.ts"
import { validate } from "../validate.ts"
import { loadLink, shortUrl } from "./links.ts"

const idParam = validate("param", z.object({ id: uuidSchema }))

type QrCodeRow = Selectable<DB["qr_codes"]> & {
  link_name: string | null
  link_status: "active" | "archived"
  slug: string
  domain_host: string
}

/** Maps a joined QR code row to the JSON shape the API returns. */
function toQrCode(row: QrCodeRow): QrCode {
  return {
    id: row.id,
    link_id: row.link_id,
    name: row.name,
    dot_color: row.dot_color,
    bg_color: row.bg_color,
    pattern: row.pattern,
    link_name: row.link_name,
    link_status: row.link_status,
    slug: row.slug,
    domain_host: row.domain_host,
    short_url: shortUrl(row.domain_host, row.slug),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

/**
 * Inner joins only: `qr_codes.link_id` is NOT NULL behind a foreign key, and
 * `links.domain_id` the same, so neither join can ever drop a row.
 */
function qrCodeQuery(db: Db) {
  return db
    .selectFrom("qr_codes")
    .innerJoin("links", "links.id", "qr_codes.link_id")
    .innerJoin("domains", "domains.id", "links.domain_id")
    .selectAll("qr_codes")
    .select(["links.name as link_name", "links.status as link_status", "links.slug", "domains.host as domain_host"])
}

/** Loads one QR code as a complete API response, or throws 404. */
function fetchQrCode(db: Db, id: string): Promise<QrCode> {
  return span(
    "qrCode.fetch",
    async () => {
      const row = await qrCodeQuery(db).where("qr_codes.id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("QR code")
      return toQrCode(row)
    },
    { in: { qr_code_id: id } },
  )
}

/** Confirms a QR code exists, or throws 404. */
function loadQrCode(db: Db, id: string): Promise<Selectable<DB["qr_codes"]>> {
  return span(
    "qrCode.load",
    async () => {
      const row = await db.selectFrom("qr_codes").selectAll().where("id", "=", id).limit(1).executeTakeFirst()
      if (!row) throw ApiError.notFound("QR code")
      return row
    },
    { in: { qr_code_id: id } },
  )
}

/**
 * Mounted top-level (`/v1/qr-codes`), because the list view spans every link.
 * Permissions are `can.editLink` — there is no `can.editQrCode`.
 */
export const qrCodeRoutes = new Hono<Env>()
  .get("/", validate("query", qrCodeListQuerySchema), async (c) => {
    const q = c.req.valid("query")

    const query = qrCodeQuery(c.var.db)
    const filtered = q.link_id ? query.where("qr_codes.link_id", "=", q.link_id) : query
    const rows = await (q.search
      ? filtered.where((eb) =>
          eb.or([
            eb("qr_codes.name", "ilike", `%${q.search}%`),
            eb("links.name", "ilike", `%${q.search}%`),
            eb("links.slug", "ilike", `%${q.search}%`),
          ]),
        )
      : filtered)
      .orderBy("qr_codes.created_at", "desc")
      .orderBy("qr_codes.id", "desc")
      .limit(q.limit)
      .offset(q.offset)
      .execute()

    // Repeats the join `links.ts` warns about: `search` filters on link
    // columns, so a count over the bare table would disagree with the page
    // it describes. The join cannot change the row count either way — `link_id`
    // is NOT NULL behind a foreign key.
    let countQuery = c.var.db
      .selectFrom("qr_codes")
      .innerJoin("links", "links.id", "qr_codes.link_id")
      .select((eb) => eb.fn.countAll<number>().as("total"))
    if (q.link_id) countQuery = countQuery.where("qr_codes.link_id", "=", q.link_id)
    if (q.search) {
      countQuery = countQuery.where((eb) =>
        eb.or([
          eb("qr_codes.name", "ilike", `%${q.search}%`),
          eb("links.name", "ilike", `%${q.search}%`),
          eb("links.slug", "ilike", `%${q.search}%`),
        ]),
      )
    }
    const { total = 0 } = (await countQuery.executeTakeFirst()) ?? {}

    return c.json({ data: rows.map(toQrCode), total, limit: q.limit, offset: q.offset })
  })

  .post("/", validate("json", qrCodeCreateSchema), async (c) => {
    const body = c.req.valid("json")
    // Unknown link first: a missing link is a 404, not a permission question.
    const link = await loadLink(c.var.db, body.link_id)
    assertCanEdit(c.var.principal)
    if (link.status === "archived") {
      throw ApiError.conflict("cannot attach a QR code to an archived link")
    }

    const row = await c.var.db
      .insertInto("qr_codes")
      .values({
        id: Bun.randomUUIDv7(),
        link_id: body.link_id,
        name: body.name ?? null,
        dot_color: body.dot_color,
        bg_color: body.bg_color,
        pattern: body.pattern,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return c.json(await fetchQrCode(c.var.db, row.id), 201)
  })

  .get("/:id", idParam, async (c) => c.json(await fetchQrCode(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", qrCodePatchSchema), async (c) => {
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    await loadQrCode(c.var.db, id)
    assertCanEdit(c.var.principal)

    // A blanket spread is safe here, unlike `links.ts`: every patchable field
    // is a string the column takes as-is, and the schema is strict.
    await c.var.db
      .updateTable("qr_codes")
      .set({ ...patch, updated_at: new Date() })
      .where("id", "=", id)
      .execute()

    return c.json(await fetchQrCode(c.var.db, id))
  })

  /** Hard delete, no archive: a QR row has no slug and no redirect, so
   *  archiving it would be ceremony with no consequence. See docs/adr/0002's
   *  amendment. */
  .delete("/:id", idParam, async (c) => {
    const { id } = c.req.valid("param")
    await loadQrCode(c.var.db, id)
    assertCanEdit(c.var.principal)

    await c.var.db.deleteFrom("qr_codes").where("id", "=", id).execute()
    return c.body(null, 204)
  })
