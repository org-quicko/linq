import type { LinkRow, LlmsEntry } from "@linq/shared"
import { UrlUtil } from "../../utils/index.ts"

/**
 * Maps a listed link to its llms.txt entry. An unnamed link is titled by its slug.
 *
 * @param row - The link's name, slug and destination.
 * @param host - The domain's host, as requested.
 * @returns The entry to render.
 */
export class LinkRowToLlmsEntryConverter {
  convertFrom(row: Pick<LinkRow, "name" | "slug" | "destination">, host: string): LlmsEntry {
    return {
      name: row.name ?? row.slug,
      url: UrlUtil.shortUrl(host, row.slug),
      destination: row.destination ?? "",
    }
  }
}
