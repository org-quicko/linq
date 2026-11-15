import { createFactory } from "hono/factory"
import { domainKey, type Env, getOrSetCache, llmsKey } from "../libs/index.ts"
import { findActiveDomain, renderLlmsForDomain } from "../services/index.ts"

/**
 * `GET|HEAD /llms.txt`. No auth, by design: the route sits outside `/api/v1`,
 * which is the whole point, and also the reason `listed` defaults to false.
 * See resources/docs/adr/0013.
 */
export const llmsHandler = createFactory<Env>().createHandlers(async (c) => {
  const host = c.req.header("host") ?? new URL(c.req.url).host
  // Reads the same `domainKey` entry the redirect warms, so a live instance
  // pays zero extra queries for this route.
  const domain = await getOrSetCache(c.var.cache, domainKey(host), () =>
    findActiveDomain(c.var.db, host),
  )
  if (!domain) return c.text("Not Found", 404)

  // The rendered string is cached as a whole, keyed by domain id: a string has
  // no `Date` problem, unlike a row array.
  const markdown = await getOrSetCache(c.var.cache, llmsKey(domain.id), () =>
    renderLlmsForDomain(c.var.db, domain.id, host),
  )

  return c.body(markdown ?? "", 200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": `public, max-age=${c.var.config.LINQ_CACHE_TTL}`,
  })
})
