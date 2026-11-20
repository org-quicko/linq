import type { Context } from "hono"
import type { Config } from "../config.ts"
import { Log } from "../libs/index.ts"
import type { LlmsService, RedirectService } from "../services/index.ts"

/**
 * HTTP layer for `GET|HEAD /llms.txt`. No auth, by design: the route sits
 * outside `/api/v1`, which is the whole point, and also the reason `listed`
 * defaults to false. See resources/docs/adr/0013.
 */
export class LlmsController {
  /**
   * @param llmsService - Renders (and caches) a domain's catalogue.
   * @param redirectService - Resolves the Host header to a domain, through the redirect's own cache entry.
   * @param config - LINQ_CACHE_TTL, the response's `max-age`.
   */
  constructor(
    private readonly llmsService: LlmsService,
    private readonly redirectService: RedirectService,
    private readonly config: Pick<Config, "LINQ_CACHE_TTL">,
  ) {}

  /**
   * GET|HEAD /llms.txt
   * The catalogue of the requested domain's listed, live links.
   *
   * @param c - Hono request context.
   * @returns The markdown document, or a plain-text 404 on a host that is no active domain.
   */
  @Log("llmsController.get")
  get = async (c: Context) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host
    // Reads the same `domainKey` entry the redirect warms, so a live instance
    // pays zero extra queries for this route.
    const domain = await this.redirectService.findActiveDomain(host)
    if (!domain) return c.text("Not Found", 404)

    return c.body(await this.llmsService.renderForDomain(domain.id, host), 200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": `public, max-age=${this.config.LINQ_CACHE_TTL}`,
    })
  }
}
