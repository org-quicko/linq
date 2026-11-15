import { ApiError, domainCreateSchema, domainPatchSchema, paginationSchema } from "@linq/shared"
import { Hono } from "hono"
import { isAppHost } from "../config.ts"
import { domainKey, type Env } from "../libs/index.ts"
import { assertCan, idParam, validate } from "../middleware/index.ts"
import {
  archiveDomain,
  createDomain,
  getDomain,
  listDomains,
  purgeDomain,
  updateDomain,
} from "../services/index.ts"

/** Routes for `/domains`. Writes clear the host's cached domain entry and sync Caddy. */
export const domainRoute = new Hono<Env>()
  .get("/", validate("query", paginationSchema), async (c) => {
    const { limit, offset } = c.req.valid("query")
    const { data, total } = await listDomains(c.var.db, { limit, offset })
    return c.json({ data, total, limit, offset })
  })

  .post("/", validate("json", domainCreateSchema), async (c) => {
    assertCan(c.var.principal, "create", "Domain")
    const body = c.req.valid("json")
    // The Client UI claims every path on the app host, so no link there could resolve.
    if (isAppHost(c.var.config, body.host)) {
      throw ApiError.validation(`${body.host} is LINQ_APP_HOST and cannot be a domain`)
    }
    const domain = await createDomain(c.var.db, body)
    // Clears the negative entry a request to this host left behind while it 404'd.
    await c.var.cache.del(domainKey(domain.host))
    await c.var.caddy.upsert(domain.id, domain.host)
    return c.json(domain, 201)
  })

  .get("/:id", idParam, async (c) => c.json(await getDomain(c.var.db, c.req.valid("param").id)))

  .patch("/:id", idParam, validate("json", domainPatchSchema), async (c) => {
    assertCan(c.var.principal, "update", "Domain")
    const { id } = c.req.valid("param")
    const patch = c.req.valid("json")
    const before = await getDomain(c.var.db, id)
    await updateDomain(c.var.db, id, patch)
    // The three redirect URLs are what the redirect handler reads out of the cached entry.
    await c.var.cache.del(domainKey(before.host))
    // A redirect-only patch changes nothing Caddy needs to know about.
    if (patch.status === "archived") await c.var.caddy.remove(id)
    else if (patch.status !== undefined) await c.var.caddy.upsert(id, before.host)
    return c.json(await getDomain(c.var.db, id))
  })

  /** DELETE is an alias for archiving; domains are never dropped. See resources/docs/adr/0002. */
  .delete("/:id", idParam, async (c) => {
    assertCan(c.var.principal, "archive", "Domain")
    const { id } = c.req.valid("param")
    const before = await getDomain(c.var.db, id)
    await archiveDomain(c.var.db, id)
    await c.var.cache.del(domainKey(before.host))
    await c.var.caddy.remove(id)
    return c.json(await getDomain(c.var.db, id))
  })

  /** Admin only, and archived-first. */
  .delete("/:id/purge", idParam, async (c) => {
    assertCan(c.var.principal, "purge", "Link")
    const domain = await getDomain(c.var.db, c.req.valid("param").id)
    await purgeDomain(c.var.db, domain)
    await c.var.cache.del(domainKey(domain.host))
    // Defensive, not load-bearing: an archived domain's route is normally gone already.
    await c.var.caddy.remove(domain.id)
    return c.body(null, 204)
  })
