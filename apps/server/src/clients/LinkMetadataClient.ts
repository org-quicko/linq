import dns from "node:dns/promises"
import net from "node:net"
import type { Metadata, MetadataFetcher } from "@linq/shared"
import type { Config } from "../config.ts"
import { Logger } from "../libs/index.ts"

/** What a destination with nothing to offer, or one that failed, reads as. */
const EMPTY_METADATA: Metadata = { name: null, description: null, icon_url: null }

/** Reads a destination's title, description and favicon, behind an SSRF guard. */
export class LinkMetadataClient implements MetadataFetcher {
  private static readonly TIMEOUT_MS = 4000
  private static readonly MAX_REDIRECTS = 3
  private static readonly MAX_BYTES = 1_000_000
  private static readonly USER_AGENT = "linq-link-preview/1.0"

  /**
   * Opens the real fetcher, or a no-op when LINQ_FETCH_LINK_METADATA=false. Not
   * guarded: `createApp` guards it at the seam.
   *
   * @param config - LINQ_FETCH_LINK_METADATA.
   * @returns The fetcher.
   */
  static start(config: Pick<Config, "LINQ_FETCH_LINK_METADATA">): MetadataFetcher {
    return config.LINQ_FETCH_LINK_METADATA === "false"
      ? new NoopLinkMetadataClient()
      : new LinkMetadataClient()
  }

  /**
   * Reads a destination's title, description and favicon, behind the SSRF guard.
   *
   * @param destination - The link's destination URL.
   * @returns What the page offers; all null when it is blocked, unreachable or not HTML.
   */
  async fetch(destination: string): Promise<Metadata> {
    const res = await LinkMetadataClient.safeFetch(destination)
    if (!res) return EMPTY_METADATA
    const html = await LinkMetadataClient.readBoundedHtml(res)
    if (!html) return EMPTY_METADATA
    return LinkMetadataClient.parseMetadata(html, res.url || destination)
  }

  private static isBlockedIp(ip: string): boolean {
    const version = net.isIP(ip)
    if (version === 4) {
      const parts = ip.split(".").map(Number)
      if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true
      const [a, b] = parts
      if (a === 127) return true // loopback 127.0.0.0/8
      if (a === 0) return true // current network 0.0.0.0/8
      if (a === 10) return true // RFC1918 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return true // RFC1918 172.16.0.0/12
      if (a === 192 && b === 168) return true // RFC1918 192.168.0.0/16
      if (a === 169 && b === 254) return true // link-local 169.254.0.0/16
      if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
      if (a >= 224) return true // multicast & reserved
      return false
    }
    if (version === 6) {
      const normalized = ip.toLowerCase()
      if (
        normalized === "::1" ||
        normalized === "::" ||
        normalized === "0:0:0:0:0:0:0:1" ||
        normalized === "0:0:0:0:0:0:0:0"
      )
        return true
      if (
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb")
      )
        return true
      if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true
      if (normalized.startsWith("ff")) return true
      if (normalized.startsWith("::ffff:"))
        return LinkMetadataClient.isBlockedIp(normalized.slice(7))
      return false
    }
    return true
  }

  private static async isBlockedHost(hostname: string): Promise<boolean> {
    const cleanHost = hostname.replace(/^\[|\]$/g, "")
    if (net.isIP(cleanHost)) return LinkMetadataClient.isBlockedIp(cleanHost)
    try {
      const addresses = await dns.lookup(cleanHost, { all: true })
      if (!addresses || addresses.length === 0) return true
      return addresses.some((addr) => LinkMetadataClient.isBlockedIp(addr.address))
    } catch {
      return true
    }
  }

  /** Follows up to LinkMetadataClient.MAX_REDIRECTS hops by hand, re-checking every hop against the SSRF guard. */
  private static async safeFetch(destination: string): Promise<Response | null> {
    let currentUrl = destination
    const signal = AbortSignal.timeout(LinkMetadataClient.TIMEOUT_MS)

    for (let hop = 0; hop <= LinkMetadataClient.MAX_REDIRECTS; hop++) {
      let parsed: URL
      try {
        parsed = new URL(currentUrl)
      } catch {
        return null
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
      if (await LinkMetadataClient.isBlockedHost(parsed.hostname)) return null

      let res: Response
      try {
        res = await fetch(parsed.toString(), {
          method: "GET",
          signal,
          redirect: "manual",
          headers: {
            "user-agent": LinkMetadataClient.USER_AGENT,
            accept: "text/html,application/xhtml+xml",
          },
        })
      } catch {
        return null
      }

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        res.body?.cancel().catch(() => {})
        if (hop === LinkMetadataClient.MAX_REDIRECTS) return null
        const location = res.headers.get("location")
        if (!location) return null
        try {
          currentUrl = new URL(location, currentUrl).toString()
        } catch {
          return null
        }
        continue
      }

      if (res.ok) return res

      res.body?.cancel().catch(() => {})
      return null
    }

    return null
  }

  private static async readBoundedHtml(res: Response): Promise<string | null> {
    const contentType = res.headers.get("content-type")
    if (!contentType?.toLowerCase().includes("text/html")) {
      res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.body) return null

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let totalBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          if (totalBytes + value.byteLength > LinkMetadataClient.MAX_BYTES) {
            const remaining = LinkMetadataClient.MAX_BYTES - totalBytes
            if (remaining > 0) chunks.push(value.subarray(0, remaining))
            await reader.cancel().catch(() => {})
            break
          }
          chunks.push(value)
          totalBytes += value.byteLength
        }
      }
    } catch {
      // cancelled or aborted
    } finally {
      reader.releaseLock()
    }

    return Buffer.concat(chunks).toString("utf-8")
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

/** What runs when LINQ_FETCH_LINK_METADATA=false, and what the test harness
 *  defaults to — no test should make a real network call by accident. */
export class NoopLinkMetadataClient implements MetadataFetcher {
  async fetch(_destination: string): Promise<Metadata> {
    return EMPTY_METADATA
  }
}

/** Makes a metadata fetch unable to fail its caller: any error reads as "no metadata". */
export class GuardedLinkMetadataClient implements MetadataFetcher {
  /**
   * @param fetcher - The fetcher to guard.
   */
  constructor(private readonly fetcher: MetadataFetcher) {}

  async fetch(destination: string): Promise<Metadata> {
    try {
      return await this.fetcher.fetch(destination)
    } catch (err) {
      Logger.forRequest().debug({ err, destination }, "link metadata fetch failed")
      return EMPTY_METADATA
    }
  }
}
