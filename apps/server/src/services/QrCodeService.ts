import {
  ApiError,
  type QrCode,
  type QrCodePatch,
  type qrCodeCreateSchema,
  type qrCodeListQuerySchema,
} from "@linq/shared"
import { type RawBuilder, type Selectable, type SqlBool, sql } from "kysely"
import type { z } from "zod"
import type { DB } from "../db/types.generated.ts"
import { type Db, span } from "../libs/index.ts"
import { shortUrl } from "./LinkService.ts"

type QrCodeCreateInput = z.infer<typeof qrCodeCreateSchema>
type QrCodeListQuery = z.infer<typeof qrCodeListQuerySchema>

/** Maps a joined QR code row to the JSON shape the API returns. */
function toQrCode(
  row: Selectable<DB["qr_codes"]> & {
    link_name: string | null
    link_status: "active" | "archived"
    slug: string
    domain_host: string
  },
): QrCode {
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
    .select([
      "links.name as link_name",
      "links.status as link_status",
      "links.slug",
      "domains.host as domain_host",
    ])
}

/** Loads one QR code as a complete API response, or throws 404. */
export function getQrCode(db: Db, id: string): Promise<QrCode> {
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
export function loadQrCode(db: Db, id: string): Promise<Selectable<DB["qr_codes"]>> {
  return span(
    "qrCode.load",
    async () => {
      const row = await db
        .selectFrom("qr_codes")
        .selectAll()
        .where("id", "=", id)
        .limit(1)
        .executeTakeFirst()
      if (!row) throw ApiError.notFound("QR code")
      return row
    },
    { in: { qr_code_id: id } },
  )
}

export async function listQrCodes(db: Db, q: QrCodeListQuery) {
  // `search` filters on link columns, so the count joins `links` too, or it
  // would disagree with the page it describes. The join cannot change the row
  // count either way — `link_id` is NOT NULL behind a foreign key.
  const filters: RawBuilder<SqlBool>[] = []
  if (q.link_id) filters.push(sql<SqlBool>`qr_codes.link_id = ${q.link_id}`)
  if (q.search) {
    const term = `%${q.search}%`
    filters.push(
      sql<SqlBool>`(qr_codes.name ilike ${term} or links.name ilike ${term} or links.slug ilike ${term})`,
    )
  }

  const rows = await qrCodeQuery(db)
    .where((eb) => eb.and(filters))
    .orderBy("qr_codes.created_at", "desc")
    .orderBy("qr_codes.id", "desc")
    .limit(q.limit)
    .offset(q.offset)
    .execute()

  const { total = 0 } =
    (await db
      .selectFrom("qr_codes")
      .innerJoin("links", "links.id", "qr_codes.link_id")
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .where((eb) => eb.and(filters))
      .executeTakeFirst()) ?? {}

  return { data: rows.map(toQrCode), total }
}

export async function createQrCode(db: Db, input: QrCodeCreateInput): Promise<QrCode> {
  const row = await db
    .insertInto("qr_codes")
    .values({
      id: Bun.randomUUIDv7(),
      link_id: input.link_id,
      name: input.name ?? null,
      dot_color: input.dot_color,
      bg_color: input.bg_color,
      pattern: input.pattern,
    })
    .returning("id")
    .executeTakeFirstOrThrow()
  return getQrCode(db, row.id)
}

/** A blanket spread is safe here: every patchable field is a string the column takes as-is. */
export async function updateQrCode(db: Db, id: string, patch: QrCodePatch): Promise<QrCode> {
  await db
    .updateTable("qr_codes")
    .set({ ...patch, updated_at: new Date() })
    .where("id", "=", id)
    .execute()
  return getQrCode(db, id)
}

/**
 * Hard delete, no archive: a QR row has no slug and no redirect, so archiving
 * it would be ceremony with no consequence. See resources/docs/adr/0002's amendment.
 */
export async function deleteQrCode(db: Db, id: string): Promise<void> {
  await db.deleteFrom("qr_codes").where("id", "=", id).execute()
}
