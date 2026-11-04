import dns from "node:dns/promises"
import net from "node:net"
import type { Config } from "./config.ts"
import { reqLog } from "./log.ts"

export type Metadata = { name: string | null; description: string | null; icon_url: string | null }
export type MetadataFetcher = { fetch(destination: string): Promise<Metadata> }

const EMPTY: Metadata = { name: null, description: null, icon_url: null }

/** What runs when LINQ_FETCH_LINK_METADATA=false, and what the test harness
 *  defaults to — no test should make a real network call by accident. */
export const noMetadata: MetadataFetcher = { fetch: async () => EMPTY }

export function guarded(fetcher: MetadataFetcher): MetadataFetcher {
  return {
    async fetch(destination) {
      try {
        return await fetcher.fetch(destination)
      } catch (err) {
        reqLog().debug({ err, destination }, "link metadata fetch failed")
        return EMPTY
      }
    },
  }
}

export function startMetadata(config: Config): MetadataFetcher {
  return config.LINQ_FETCH_LINK_METADATA === "false" ? noMetadata : httpMetadataFetcher()
}

const TIMEOUT_MS = 4000
const MAX_REDIRECTS = 3
const MAX_BYTES = 1_000_000
const USER_AGENT = "linq-link-preview/1.0"

function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip)
  if (v === 4) {
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
  if (v === 6) {
    const norm = ip.toLowerCase()
    if (norm === "::1" || norm === "::" || norm === "0:0:0:0:0:0:0:1" || norm === "0:0:0:0:0:0:0:0")
      return true
    if (
      norm.startsWith("fe8") ||
      norm.startsWith("fe9") ||
      norm.startsWith("fea") ||
      norm.startsWith("feb")
    )
      return true
    if (norm.startsWith("fc") || norm.startsWith("fd")) return true
    if (norm.startsWith("ff")) return true
    if (norm.startsWith("::ffff:")) {
      return isBlockedIp(norm.slice(7))
    }
    return false
  }
  return true
}

async function isBlocked(hostname: string): Promise<boolean> {
  const cleanHost = hostname.replace(/^\[|\]$/g, "")
  if (net.isIP(cleanHost)) {
    return isBlockedIp(cleanHost)
  }
  try {
    const addresses = await dns.lookup(cleanHost, { all: true })
    if (!addresses || addresses.length === 0) return true
    for (const addr of addresses) {
      if (isBlockedIp(addr.address)) return true
    }
    return false
  } catch {
    return true
  }
}

async function safeFetch(destination: string): Promise<Response | null> {
  let currentUrl = destination
  const signal = AbortSignal.timeout(TIMEOUT_MS)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL
    try {
      parsed = new URL(currentUrl)
    } catch {
      return null
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }

    if (await isBlocked(parsed.hostname)) {
      return null
    }

    let res: Response
    try {
      res = await fetch(parsed.toString(), {
        method: "GET",
        signal,
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      })
    } catch {
      return null
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop === MAX_REDIRECTS) {
        res.body?.cancel().catch(() => {})
        return null
      }
      const location = res.headers.get("location")
      res.body?.cancel().catch(() => {})
      if (!location) return null
      try {
        currentUrl = new URL(location, currentUrl).toString()
      } catch {
        return null
      }
      continue
    }

    if (res.ok) {
      return res
    }

    res.body?.cancel().catch(() => {})
    return null
  }

  return null
}

async function readBoundedHtml(res: Response): Promise<string | null> {
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
        if (totalBytes + value.byteLength > MAX_BYTES) {
          const remaining = MAX_BYTES - totalBytes
          if (remaining > 0) {
            chunks.push(value.subarray(0, remaining))
          }
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

function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    const url = new URL(href, baseUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.toString()
  } catch {
    return null
  }
}

function parseMetadata(html: string, baseUrl: string): Metadata {
  let ogTitle = ""
  let twitterTitle = ""
  let titleTag = ""

  let ogDescription = ""
  let twitterDescription = ""
  let metaDescription = ""

  let iconHref = ""
  let appleIconHref = ""

  const rewriter = new HTMLRewriter()
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

  rewriter.transform(html)

  const name = ogTitle || twitterTitle || titleTag.trim() || null
  const description = ogDescription || twitterDescription || metaDescription || null
  const icon_url = resolveUrl(iconHref || appleIconHref || "/favicon.ico", baseUrl)

  return { name, description, icon_url }
}

async function fetch_(destination: string): Promise<Metadata> {
  const res = await safeFetch(destination)
  if (!res) return EMPTY
  const html = await readBoundedHtml(res)
  if (!html) return EMPTY
  return parseMetadata(html, res.url || destination)
}

export function httpMetadataFetcher(): MetadataFetcher {
  return { fetch: fetch_ }
}
