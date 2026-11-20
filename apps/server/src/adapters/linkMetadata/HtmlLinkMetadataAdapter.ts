import { EMPTY_METADATA, type Metadata, type MetadataFetcher } from "@linq/shared"
import { LinkMetadataClient } from "../../clients/index.ts"

/**
 * The link-metadata port over the destination's own HTML: its title,
 * description and favicon, read from the page `LinkMetadataClient` fetched
 * behind the SSRF guard. See resources/docs/adr/0014.
 */
export class HtmlLinkMetadataAdapter implements MetadataFetcher {
  private readonly client: LinkMetadataClient

  constructor() {
    this.client = new LinkMetadataClient()
  }

  /**
   * Reads a destination's title, description and favicon.
   *
   * @param destination - The link's destination URL.
   * @returns What the page offers; all null when it is blocked, unreachable or not HTML.
   */
  async fetch(destination: string): Promise<Metadata> {
    const page = await this.client.fetchHtml(destination)
    return page ? HtmlLinkMetadataAdapter.parseMetadata(page.html, page.url) : EMPTY_METADATA
  }

  private static parseMetadata(html: string, baseUrl: string): Metadata {
    let ogTitle = ""
    let twitterTitle = ""
    let titleTag = ""

    let ogDescription = ""
    let twitterDescription = ""
    let metaDescription = ""

    let iconHref = ""
    let appleIconHref = ""

    new HTMLRewriter()
      .on("title", {
        text(chunk) {
          titleTag += chunk.text
        },
      })
      .on('meta[property="og:title" i], meta[name="og:title" i]', {
        element(el) {
          ogTitle = ogTitle || el.getAttribute("content")?.trim() || ""
        },
      })
      .on('meta[name="twitter:title" i], meta[property="twitter:title" i]', {
        element(el) {
          twitterTitle = twitterTitle || el.getAttribute("content")?.trim() || ""
        },
      })
      .on('meta[property="og:description" i], meta[name="og:description" i]', {
        element(el) {
          ogDescription = ogDescription || el.getAttribute("content")?.trim() || ""
        },
      })
      .on('meta[name="twitter:description" i], meta[property="twitter:description" i]', {
        element(el) {
          twitterDescription = twitterDescription || el.getAttribute("content")?.trim() || ""
        },
      })
      .on('meta[name="description" i]', {
        element(el) {
          metaDescription = metaDescription || el.getAttribute("content")?.trim() || ""
        },
      })
      .on('link[rel~="icon" i]', {
        element(el) {
          iconHref = iconHref || el.getAttribute("href")?.trim() || ""
        },
      })
      .on('link[rel="apple-touch-icon" i]', {
        element(el) {
          appleIconHref = appleIconHref || el.getAttribute("href")?.trim() || ""
        },
      })
      .transform(html)

    // Only an http(s) icon is kept: a `javascript:` or `data:` href is dropped.
    let iconUrl: string | null = null
    try {
      const url = new URL(iconHref || appleIconHref || "/favicon.ico", baseUrl)
      if (url.protocol === "http:" || url.protocol === "https:") iconUrl = url.toString()
    } catch {
      // An unparseable href has no icon to offer.
    }

    return {
      name: ogTitle || twitterTitle || titleTag.trim() || null,
      description: ogDescription || twitterDescription || metaDescription || null,
      icon_url: iconUrl,
    }
  }
}
