import dns from "node:dns/promises"
import net from "node:net"

/**
 * Fetches a link destination's HTML behind an SSRF guard: http(s) only, no
 * private, loopback or link-local address on any hop, a timeout, a redirect
 * limit and a byte cap. `HtmlLinkMetadataAdapter` reads the metadata out of it.
 */
export class LinkMetadataClient {
  private static readonly TIMEOUT_MS = 4000
  private static readonly MAX_REDIRECTS = 3
  private static readonly MAX_BYTES = 1_000_000
  private static readonly USER_AGENT = "linq-link-preview/1.0"

  /**
   * Fetches a destination's HTML, following redirects by hand.
   *
   * @param destination - The link's destination URL.
   * @returns The HTML and the URL it was finally served from, or null when the
   *   destination is blocked, unreachable or not HTML.
   */
  async fetchHtml(destination: string): Promise<{ html: string; url: string } | null> {
    const res = await LinkMetadataClient.safeFetch(destination)
    if (!res) return null
    const html = await LinkMetadataClient.readBoundedHtml(res)
    if (!html) return null
    return { html, url: res.url || destination }
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
}
