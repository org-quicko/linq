import type { Config } from "../config.ts"

/** Short URLs, Client UI paths, Host header matching and query merging. */
export class UrlUtil {
  /**
   * The public short URL of a slug on a host. A port only ever appears in a
   * local setup, where no TLS terminator is in front, so that alone gets `http`.
   *
   * @param host - The domain host, with an optional port.
   * @param slug - The link's slug.
   * @returns The absolute short URL.
   */
  static shortUrl(host: string, slug: string): string {
    const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https"
    return `${scheme}://${host}/${slug}`
  }

  /**
   * A path under the Client UI mount. A root mount has no prefix, so `/` + `/x`
   * must not become the protocol-relative `//x`.
   *
   * @param basePath - LINQ_CLIENT_BASE_PATH.
   * @param path - The path under the mount, starting with `/`.
   * @returns The absolute path.
   */
  static clientPath(basePath: string, path: string): string {
    return basePath === "/" ? path : `${basePath}${path}`
  }

  /**
   * The hosts a Host header may match: exactly as sent (lowercased) first, then
   * with its port stripped, so one `links.example.com` row also answers requests
   * on a non-standard port while `localhost:3000` still matches verbatim.
   *
   * @param hostHeader - The request's Host header.
   * @returns One host, or the exact host followed by its port-stripped form.
   */
  static candidateHosts(hostHeader: string): string[] {
    const host = hostHeader.trim().toLowerCase()
    const bare = host.replace(/:\d+$/, "")
    return bare === host ? [host] : [host, bare]
  }

  /**
   * Whether a request's Host header names LINQ_APP_HOST, matched the same way a
   * domain row is.
   *
   * @param config - The config, for LINQ_APP_HOST.
   * @param hostHeader - The request's Host header.
   * @returns True when LINQ_APP_HOST is set and the header names it.
   */
  static isAppHost(config: Pick<Config, "LINQ_APP_HOST">, hostHeader: string): boolean {
    return (
      !!config.LINQ_APP_HOST && UrlUtil.candidateHosts(hostHeader).includes(config.LINQ_APP_HOST)
    )
  }

  /**
   * The given parameters win per key, and repeats survive: every key in
   * `overrides` replaces the destination's copy of that key entirely.
   *
   * @param destination - An absolute URL.
   * @param overrides - The parameters to merge in.
   * @returns The destination with the overrides applied.
   */
  static mergeQueryParams(destination: string, overrides: URLSearchParams): string {
    const url = new URL(destination)
    for (const key of new Set(overrides.keys())) url.searchParams.delete(key)
    for (const [key, value] of overrides) url.searchParams.append(key, value)
    return url.toString()
  }
}
