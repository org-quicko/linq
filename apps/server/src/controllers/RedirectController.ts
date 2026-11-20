import { SLUG_PATTERN } from "@linq/shared"
import type { Context } from "hono"
import type { Config } from "../config.ts"
import { URLSearchParamsToQueryParamsConverter } from "../converters/index.ts"
import { Log, Logger } from "../libs/index.ts"
import type { RedirectService, VisitService } from "../services/index.ts"
import { HtmlUtil, RuleMatchUtil, SlugUtil, UrlUtil, UserAgentUtil } from "../utils/index.ts"

/**
 * The redirect hot path: `GET|HEAD /:slug` and `GET|HEAD /`. Resolves the host
 * and slug through `RedirectService` (both cached), picks the destination, and
 * hands the visit to `VisitService` without awaiting it.
 */
export class RedirectController {
  private readonly urlSearchParamsToQueryParamsConverter: URLSearchParamsToQueryParamsConverter

  /**
   * @param redirectService - Domain and target resolution, read through the cache.
   * @param visitService - Records each tracked visit, fire-and-forget.
   * @param config - The Client UI's base path and LINQ_APP_HOST, for reserved paths and the root fallback.
   */
  constructor(
    private readonly redirectService: RedirectService,
    private readonly visitService: VisitService,
    private readonly config: Pick<Config, "LINQ_CLIENT_BASE_PATH" | "LINQ_APP_HOST">,
  ) {
    this.urlSearchParamsToQueryParamsConverter = new URLSearchParamsToQueryParamsConverter()
  }

  /**
   * GET|HEAD /*
   * Redirects a short link, or answers a link-preview crawler with an OG page.
   * HEAD is answered exactly like GET but never tracked.
   *
   * @param c - Hono request context.
   * @returns A 302 to the destination, an OG preview page, or a plain-text 404.
   */
  @Log("redirectController.redirect")
  redirect = async (c: Context) => {
    const { config } = this
    const url = new URL(c.req.url)
    const slug = url.pathname.replace(/\/+$/, "").slice(1)

    // 1. Reserved paths belong to the API, the Client UI and robots.txt. Matching on
    //    the first segment covers API typos and unknown UI subpaths too, so an
    //    unclaimed one 404s instead of becoming an orphan visit on the fallback.
    const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
    if (SlugUtil.isReservedSlug(firstSegment, config.LINQ_CLIENT_BASE_PATH))
      return c.text("Not Found", 404)

    // 2. An unknown or archived domain is not ours to report on — except at the
    //    root path of a host nobody ever registered at all, where the Client UI is
    //    a friendlier landing place than a bare 404. An archived domain's root
    //    path stays a 404 like everything else on it (hostHasAnyDomain is what
    //    tells the two apart). That fallback is not cached, for the same reason
    //    as `sendRedirect`; with LINQ_APP_HOST set the UI answers only there.
    const host = c.req.header("host") ?? url.host
    const domain = await this.redirectService.findActiveDomain(host)
    if (!domain) {
      if (slug === "" && !(await this.redirectService.hostHasAnyDomain(host))) {
        const adminPath = UrlUtil.clientPath(config.LINQ_CLIENT_BASE_PATH, "/")
        return RedirectController.sendRedirect(
          c,
          config.LINQ_APP_HOST
            ? UrlUtil.shortUrl(config.LINQ_APP_HOST, adminPath.slice(1))
            : adminPath,
        )
      }
      return c.text("Not Found", 404)
    }

    const tracked = c.req.method === "GET"
    const userAgent = c.req.header("user-agent") ?? null
    const cached = slug ? await this.redirectService.findActiveTarget(domain.id, slug) : null

    // 2b. An expired link is an unknown slug: same orphan path, same null
    //     link_id, same fallback. Checked here rather than in SQL because the
    //     cached entry outlives the moment it lapses and no mutation ever arrives
    //     to invalidate it: `status` is safe in SQL only because every status
    //     change also dels `targetKey`.
    const isExpired = typeof cached?.expires_at === "number" && cached.expires_at <= Date.now()
    if (isExpired) Logger.forRequest().debug({ link_id: cached?.link_id, slug }, "link expired")
    const link = isExpired ? null : cached

    const visit = {
      domain_id: domain.id,
      slug_requested: slug,
      ...UserAgentUtil.classifyBot(userAgent),
      platform: UserAgentUtil.detectPlatform(userAgent),
      ...UserAgentUtil.detectOsAndBrowser(userAgent),
      user_agent: userAgent,
      referer: c.req.header("referer") ?? null,
      query_params: this.urlSearchParamsToQueryParamsConverter.convertFrom(url.searchParams),
    }

    // 3. Root path, unknown slug or archived link: an orphan visit on a live domain.
    //    Three redirect fields, three cases, in this order — root path wins over
    //    malformed (an empty slug also fails SLUG_PATTERN, so it must be checked
    //    first), and each falls back to `fallback_url` when unset. `?? null`
    //    guards a cache entry written before these fields existed.
    //
    //    No admin-UI fallback here: this domain was deliberately registered as a
    //    real shortening domain, so an unconfigured root redirect gets the same
    //    404 as any other unclaimed path.
    if (!link) {
      const destination =
        slug === ""
          ? (domain.base_path_redirect ?? domain.fallback_url)
          : SLUG_PATTERN.test(slug)
            ? domain.fallback_url
            : (domain.invalid_short_url_redirect ?? domain.fallback_url)
      if (tracked) this.visitService.record({ ...visit, link_id: null, destination })
      if (!destination) return c.text("Not Found", 404)
      return UserAgentUtil.isPreviewCrawler(userAgent)
        ? RedirectController.ogPreview(c, host, slug, null)
        : RedirectController.sendRedirect(c, destination)
    }

    // 4-5. The first rule whose conditions all hold supplies the destination.
    //      No match falls back to the link default.
    const ruled = RuleMatchUtil.matchRules(link.rules, {
      platform: visit.platform,
      query: url.searchParams,
    })
    const chosen = ruled ?? link.destination
    Logger.forRequest().debug(
      { link_id: link.link_id, matchedRule: ruled !== null },
      "rules matched",
    )

    // 6. `forward_query` is the link's switch for touching the outgoing query at
    //    all: off passes the destination through exactly as written, presets
    //    included. On, the incoming query merges in first and the link's own
    //    preset params then overwrite whatever is there. This only ever affects
    //    where the browser is sent, never what gets recorded: the visit's own
    //    `query` field already carries whatever the caller sent.
    let sendTo = chosen
    if (link.forward_query) {
      sendTo = UrlUtil.mergeQueryParams(chosen, url.searchParams)
      if (Object.keys(link.preset_params).length)
        sendTo = UrlUtil.mergeQueryParams(sendTo, new URLSearchParams(link.preset_params))
    }

    // 7. Never awaited. Recorded as `chosen` — the Destination the link or rule
    //    actually names — not `sendTo`, which is effectively unique per click.
    if (tracked) this.visitService.record({ ...visit, link_id: link.link_id, destination: chosen })

    return UserAgentUtil.isPreviewCrawler(userAgent)
      ? RedirectController.ogPreview(c, host, slug, link)
      : RedirectController.sendRedirect(c, sendTo)
  }

  /**
   * Always 302, never cached: the destination can change under a live slug.
   *
   * @param c - Hono request context.
   * @param destination - Where to send the browser.
   * @returns The redirect response.
   */
  private static sendRedirect(c: Context, destination: string) {
    c.header("cache-control", "no-store")
    return c.redirect(destination, 302)
  }

  /**
   * What a link-preview crawler gets instead of the redirect: the short link's
   * own title, never the destination's. `link` is null on the orphan path,
   * where there's nothing to title it with but the domain itself.
   *
   * @param c - Hono request context.
   * @param host - The requested host.
   * @param slug - The requested slug.
   * @param link - The resolved link, or null on the orphan path.
   * @returns The OG preview page.
   */
  private static ogPreview(
    c: Context,
    host: string,
    slug: string,
    link: { name: string | null } | null,
  ) {
    const title = HtmlUtil.escapeHtml(link?.name ?? host)
    const url = HtmlUtil.escapeHtml(UrlUtil.shortUrl(host, slug))
    c.header("cache-control", "no-store")
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8">` +
        `<title>${title}</title>` +
        `<meta property="og:type" content="website">` +
        `<meta property="og:title" content="${title}">` +
        `<meta property="og:url" content="${url}">` +
        `</head><body></body></html>`,
    )
  }
}
