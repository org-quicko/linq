import {
  ApiError,
  type Page,
  type QrCode,
  type qrCodeCreateSchema,
  type qrCodeListQuerySchema,
  type qrCodePatchSchema,
} from "@linq/shared"
import type { Selectable } from "kysely"
import type { z } from "zod"
import type { Principal } from "../auth/middleware.ts"
import { assertCanEdit } from "../auth/permissions.ts"
import type { Db } from "../db/client.ts"
import type { DB } from "../db/types.generated.ts"
import type { Deps } from "../deps.ts"
import { loadLink, shortUrl } from "../links/service.ts"
import { span } from "../log.ts"

type QrCodeListQuery = z.infer<typeof qrCodeListQuerySchema>
type QrCodeCreate = z.infer<typeof qrCodeCreateSchema>
type QrCodePatch = z.infer<typeof qrCodePatchSchema>

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

export async function listQrCodes({ db }: Deps, q: QrCodeListQuery): Promise<Page<QrCode>> {
  const query = qrCodeQuery(db)
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

  // Repeats the join `links/service.ts` warns about: `search` filters on link
  // columns, so a count over the bare table would disagree with the page
  // it describes. The join cannot change the row count either way — `link_id`
  // is NOT NULL behind a foreign key.
  let countQuery = db
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

  return { data: rows.map(toQrCode), total, limit: q.limit, offset: q.offset }
}

export async function createQrCode({ db }: Deps, principal: Principal, body: QrCodeCreate): Promise<QrCode> {
  // Unknown link first: a missing link is a 404, not a permission question.
  const link = await loadLink(db, body.link_id)
  assertCanEdit(principal)
  if (link.status === "archived") {
    throw ApiError.conflict("cannot attach a QR code to an archived link")
  }

  const row = await db
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

  return fetchQrCode(db, row.id)
}

export function getQrCode({ db }: Deps, id: string): Promise<QrCode> {
  return fetchQrCode(db, id)
}

export async function updateQrCode(
  { db }: Deps,
  principal: Principal,
  id: string,
  patch: QrCodePatch,
): Promise<QrCode> {
  await loadQrCode(db, id)
  assertCanEdit(principal)

  // A blanket spread is safe here, unlike links: every patchable field
  // is a string the column takes as-is, and the schema is strict.
  await db
    .updateTable("qr_codes")
    .set({ ...patch, updated_at: new Date() })
    .where("id", "=", id)
    .execute()

  return fetchQrCode(db, id)
}

/** Hard delete, no archive: a QR row has no slug and no redirect, so
 *  archiving it would be ceremony with no consequence. See resources/docs/adr/0002's
 *  amendment. */
export async function deleteQrCode({ db }: Deps, principal: Principal, id: string): Promise<void> {
  await loadQrCode(db, id)
  assertCanEdit(principal)
  await db.deleteFrom("qr_codes").where("id", "=", id).execute()
}
