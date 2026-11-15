import { SLUG_PATTERN } from "@linq/shared"
import type { Context } from "hono"
import { createFactory } from "hono/factory"
import { clientPath, isReservedSlug } from "../config.ts"
import {
  classifyBot,
  detectOsAndBrowser,
  detectPlatform,
  domainKey,
  type Env,
  isPreviewCrawler,
  readThrough,
  reqLog,
  targetKey,
} from "../libs/index.ts"
import {
  findActiveDomain,
  findActiveTarget,
  hostHasAnyDomain,
  matchRules,
  mergeQuery,
  recordVisit,
  shortUrl,
  toQueryParams,
} from "../services/index.ts"

/** Always 302, never cached: the destination can change under a live slug. */
function sendRedirect(c: Context<Env>, destination: string) {
  c.header("cache-control", "no-store")
  return c.redirect(destination, 302)
}

/**
 * What a link-preview crawler gets instead of the redirect: the short link's
 * own title, never the destination's. `link` is null on the orphan path,
 * where there's nothing to title it with but the domain itself.
 */
function ogPreview(
  c: Context<Env>,
  host: string,
  slug: string,
  link: { name: string | null } | null,
) {
  const escapeHtml = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;")
  const title = escapeHtml(link?.name ?? host)
  const url = escapeHtml(shortUrl(host, slug))
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

/**
 * `GET|HEAD /:slug` and `GET|HEAD /`. Mounted last so every path linq answers
 * itself has already been claimed.
 */
export const redirectHandler = createFactory<Env>().createHandlers(async (c) => {
  const { db, cache, config } = c.var
  const url = new URL(c.req.url)
  const slug = url.pathname.replace(/\/+$/, "").slice(1)

  // 1. Reserved paths belong to the API, the Client UI and robots.txt. Matching on
  //    the first segment covers API typos and unknown UI subpaths too, so an
  //    unclaimed one 404s instead of becoming an orphan visit on the fallback.
  const firstSegment = slug.split("/")[0]?.toLowerCase() ?? ""
  if (isReservedSlug(firstSegment, config.LINQ_CLIENT_BASE_PATH)) return c.text("Not Found", 404)

  // 2. An unknown or archived domain is not ours to report on — except at the
  //    root path of a host nobody ever registered at all, where the Client UI is
  //    a friendlier landing place than a bare 404. An archived domain's root
  //    path stays a 404 like everything else on it (hostHasAnyDomain is what
  //    tells the two apart). That fallback is not cached, for the same reason
  //    as `sendRedirect`; with LINQ_APP_HOST set the UI answers only there.
  const host = c.req.header("host") ?? url.host
  const domain = await readThrough(cache, domainKey(host), () => findActiveDomain(db, host))
  if (!domain) {
    if (slug === "" && !(await hostHasAnyDomain(db, host))) {
      const adminPath = clientPath(config.LINQ_CLIENT_BASE_PATH, "/")
      return sendRedirect(
        c,
        config.LINQ_APP_HOST ? shortUrl(config.LINQ_APP_HOST, adminPath.slice(1)) : adminPath,
      )
    }
    return c.text("Not Found", 404)
  }

  // HEAD is answered exactly like GET but never tracked.
  const tracked = c.req.method === "GET"
  const userAgent = c.req.header("user-agent") ?? null
  const cached = slug
    ? await readThrough(cache, targetKey(domain.id, slug), () =>
        findActiveTarget(db, domain.id, slug),
      )
    : null

  // 2b. An expired link is an unknown slug: same orphan path, same null
  //     link_id, same fallback. Checked here rather than in SQL because the
  //     cached entry outlives the moment it lapses and no mutation ever arrives
  //     to invalidate it: `status` is safe in SQL only because every status
  //     change also rewrites or dels `targetKey`.
  const isExpired = typeof cached?.expires_at === "number" && cached.expires_at <= Date.now()
  if (isExpired) reqLog().debug({ link_id: cached?.link_id, slug }, "link expired")
  const link = isExpired ? null : cached

  const visit = {
    domain_id: domain.id,
    slug_requested: slug,
    ...classifyBot(userAgent),
    platform: detectPlatform(userAgent),
    ...detectOsAndBrowser(userAgent),
    user_agent: userAgent,
    referer: c.req.header("referer") ?? null,
    query_params: toQueryParams(url.searchParams),
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
    if (tracked)
      recordVisit(db, { ...visit, link_id: null, destination }, config.LINQ_VISIT_MAX_PENDING)
    if (!destination) return c.text("Not Found", 404)
    return isPreviewCrawler(userAgent)
      ? ogPreview(c, host, slug, null)
      : sendRedirect(c, destination)
  }

  // 4-5. The first rule whose conditions all hold supplies the destination.
  //      No match falls back to the link default.
  const ruled = matchRules(link.rules, { platform: visit.platform, query: url.searchParams })
  const chosen = ruled ?? link.destination
  reqLog().debug({ link_id: link.link_id, matchedRule: ruled !== null }, "rules matched")

  // 6. `forward_query` is the link's switch for touching the outgoing query at
  //    all: off passes the destination through exactly as written, presets
  //    included. On, the incoming query merges in first and the link's own
  //    preset params then overwrite whatever is there. This only ever affects
  //    where the browser is sent, never what gets recorded: the visit's own
  //    `query` field already carries whatever the caller sent.
  let sendTo = chosen
  if (link.forward_query) {
    sendTo = mergeQuery(chosen, url.searchParams)
    if (Object.keys(link.preset_params).length)
      sendTo = mergeQuery(sendTo, new URLSearchParams(link.preset_params))
  }

  // 7. Never awaited. Recorded as `chosen` — the Destination the link or rule
  //    actually names — not `sendTo`, which is effectively unique per click.
  if (tracked)
    recordVisit(
      db,
      { ...visit, link_id: link.link_id, destination: chosen },
      config.LINQ_VISIT_MAX_PENDING,
    )

  return isPreviewCrawler(userAgent) ? ogPreview(c, host, slug, link) : sendRedirect(c, sendTo)
})
