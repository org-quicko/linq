import { domainCreateSchema, domainPatchSchema, paginationSchema } from "@linq/shared"
import type { Context } from "hono"
import { Log } from "../libs/index.ts"
import { authorize, idParamSchema, parseRequest } from "../middleware/index.ts"
import type { DomainService } from "../services/index.ts"

/**
 * HTTP layer for `/domains`. Validates the request, asks the permission
 * question, and hands the rest to `DomainService`, which clears the host's
 * cached domain entry and syncs Caddy on every write.
 */
export class DomainController {
  /**
   * @param domainService - Domain queries, business rules and their side effects.
   */
  constructor(private readonly domainService: DomainService) {}

  /**
   * GET /domains
   * Lists one page of domains, by host.
   *
   * @param c - Hono request context; accepts `limit` and `offset` query params.
   * @returns JSON `{ data, total, limit, offset }`.
   * @throws {HttpError} 400 if the query does not validate.
   */
  @Log("domainController.list")
  list = async (c: Context) => {
    const { limit, offset } = await parseRequest(c, "query", paginationSchema)
    const { data, total } = await this.domainService.list({ limit, offset })
    return c.json({ data, total, limit, offset })
  }

  /**
   * POST /domains
   * Registers a domain.
   *
   * @param c - Hono request context; expects a `domainCreateSchema` JSON body.
   * @returns JSON response with the created domain, 201.
   * @throws {HttpError} 400 if the body does not validate or the host is LINQ_APP_HOST.
   * @throws {HttpError} 403 if the key may not create domains.
   * @throws {HttpError} 409 if the host is already registered.
   */
  @Log("domainController.create")
  create = async (c: Context) => {
    const body = await parseRequest(c, "json", domainCreateSchema)
    authorize(c.var.principal, "create", "Domain")
    return c.json(await this.domainService.create(body), 201)
  }

  /**
   * GET /domains/:id
   * Fetches a single domain.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the domain.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 404 if no domain matches the id.
   */
  @Log("domainController.get")
  get = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    return c.json(await this.domainService.get(id))
  }

  /**
   * PATCH /domains/:id
   * Partially updates a domain: its redirect URLs, or its status.
   *
   * @param c - Hono request context; expects an `id` route param and a `domainPatchSchema` JSON body.
   * @returns JSON response with the updated domain.
   * @throws {HttpError} 400 if the id or body does not validate.
   * @throws {HttpError} 403 if the key may not update domains.
   * @throws {HttpError} 404 if no domain matches the id.
   * @throws {HttpError} 409 if archiving a domain that still has links.
   */
  @Log("domainController.update")
  update = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    const patch = await parseRequest(c, "json", domainPatchSchema)
    authorize(c.var.principal, "update", "Domain")
    return c.json(await this.domainService.update(id, patch))
  }

  /**
   * DELETE /domains/:id
   * Archives a domain: DELETE is an alias for archiving; domains are never
   * dropped. See resources/docs/adr/0002.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns JSON response with the archived domain.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not archive domains.
   * @throws {HttpError} 404 if no domain matches the id.
   * @throws {HttpError} 409 if the domain still has links.
   */
  @Log("domainController.archive")
  archive = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    authorize(c.var.principal, "archive", "Domain")
    return c.json(await this.domainService.archive(id))
  }

  /**
   * DELETE /domains/:id/purge
   * Destroys one archived, empty domain for good. Admin only, and archived-first.
   *
   * @param c - Hono request context; expects an `id` route param.
   * @returns Empty 204 response.
   * @throws {HttpError} 400 if the id is not a UUID.
   * @throws {HttpError} 403 if the key may not purge.
   * @throws {HttpError} 404 if no domain matches the id.
   * @throws {HttpError} 409 if the domain is not archived, or still has links.
   */
  @Log("domainController.purge")
  purge = async (c: Context) => {
    const { id } = await parseRequest(c, "param", idParamSchema)
    authorize(c.var.principal, "purge", "Link")
    await this.domainService.purge(await this.domainService.get(id))
    return c.body(null, 204)
  }
}
