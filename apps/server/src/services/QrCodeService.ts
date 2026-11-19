import type {
  LinkRow,
  QrCode,
  QrCodeCreateInput,
  QrCodeListQuery,
  QrCodePatch,
  QrCodeRow,
} from "@linq/shared"
import type { Db } from "../clients/index.ts"
import {
  QrCodeCreateInputToQrCodeInsertConverter,
  QrCodeJoinedRowToQrCodeConverter,
} from "../converters/index.ts"
import { HttpError, Log } from "../libs/index.ts"
import { FilterUtil } from "../utils/index.ts"

/** QR codes: a styled code pointing at one link's short URL. */
export class QrCodeService {
  private readonly qrCodeCreateInputToQrCodeInsertConverter: QrCodeCreateInputToQrCodeInsertConverter
  private readonly qrCodeJoinedRowToQrCodeConverter: QrCodeJoinedRowToQrCodeConverter

  /**
   * @param db - The database.
   */
  constructor(private readonly db: Db) {
    this.qrCodeCreateInputToQrCodeInsertConverter = new QrCodeCreateInputToQrCodeInsertConverter()
    this.qrCodeJoinedRowToQrCodeConverter = new QrCodeJoinedRowToQrCodeConverter()
  }

  /**
   * Loads one QR code as a complete API response.
   *
   * @param id - id of the QR code.
   * @returns The QR code, with its link's name, status and short URL.
   * @throws {HttpError} 404 if no QR code matches the id.
   */
  @Log("qrCode.fetch", { in: (id: string) => ({ qr_code_id: id }) })
  async get(id: string): Promise<QrCode> {
    const row = await this.qrCodeQuery().where("qr_codes.id", "=", id).limit(1).executeTakeFirst()
    if (!row) throw HttpError.notFound("QR code")
    return this.qrCodeJoinedRowToQrCodeConverter.convertFrom(row)
  }

  /**
   * Loads the raw row, for permission checks that run before the change.
   *
   * @param id - id of the QR code.
   * @returns The QR code row.
   * @throws {HttpError} 404 if no QR code matches the id.
   */
  @Log("qrCode.load", { in: (id: string) => ({ qr_code_id: id }) })
  async load(id: string): Promise<QrCodeRow> {
    const row = await this.db
      .selectFrom("qr_codes")
      .selectAll()
      .where("id", "=", id)
      .limit(1)
      .executeTakeFirst()
    if (!row) throw HttpError.notFound("QR code")
    return row
  }

  /**
   * Lists one filtered page of QR codes, newest first.
   *
   * @param q - Filters and page.
   * @returns The page, and the total the filters match.
   */
  async list(q: QrCodeListQuery) {
    // `search` filters on link columns, so the count joins `links` too, or it
    // would disagree with the page it describes. The join cannot change the row
    // count either way — `link_id` is NOT NULL behind a foreign key.
    const filters = FilterUtil.qrCodeFilters(q)

    const rows = await this.qrCodeQuery()
      .where((eb) => eb.and(filters))
      .orderBy("qr_codes.created_at", "desc")
      .orderBy("qr_codes.id", "desc")
      .limit(q.limit)
      .offset(q.offset)
      .execute()

    const { total = 0 } =
      (await this.db
        .selectFrom("qr_codes")
        .innerJoin("links", "links.id", "qr_codes.link_id")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .where((eb) => eb.and(filters))
        .executeTakeFirst()) ?? {}

    return {
      data: rows.map((row) => this.qrCodeJoinedRowToQrCodeConverter.convertFrom(row)),
      total,
    }
  }

  /**
   * Attaches a QR code to a live link.
   *
   * @param link - The link, as loaded for the permission check.
   * @param input - The validated create body.
   * @returns The created QR code.
   * @throws {HttpError} 409 if the link is archived.
   */
  async create(link: LinkRow, input: QrCodeCreateInput): Promise<QrCode> {
    if (link.status === "archived")
      throw HttpError.conflict("cannot attach a QR code to an archived link")
    const row = await this.db
      .insertInto("qr_codes")
      .values({
        id: Bun.randomUUIDv7(),
        ...this.qrCodeCreateInputToQrCodeInsertConverter.convertFrom(input),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
    return this.get(row.id)
  }

  /**
   * Applies a patch. A blanket spread is safe here: every patchable field is a
   * string the column takes as-is.
   *
   * @param id - id of the QR code.
   * @param patch - The validated patch body.
   * @returns The updated QR code.
   */
  async update(id: string, patch: QrCodePatch): Promise<QrCode> {
    await this.db
      .updateTable("qr_codes")
      .set({ ...patch, updated_at: new Date() })
      .where("id", "=", id)
      .execute()
    return this.get(id)
  }

  /**
   * Hard delete, no archive: a QR row has no slug and no redirect, so archiving
   * it would be ceremony with no consequence. See resources/docs/adr/0002's amendment.
   *
   * @param id - id of the QR code.
   */
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom("qr_codes").where("id", "=", id).execute()
  }

  /**
   * Inner joins only: `qr_codes.link_id` is NOT NULL behind a foreign key, and
   * `links.domain_id` the same, so neither join can ever drop a row.
   *
   * @returns The joined select, ready for a `where`.
   */
  private qrCodeQuery() {
    return this.db
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
}
