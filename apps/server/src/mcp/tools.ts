import {
  type Action,
  ApiError,
  analyticsSummaryQuerySchema,
  linkCreateSchema,
  linkListQuerySchema,
  linkPatchSchema,
  paginationSchema,
  rulesPutSchema,
  type Subject,
  tagSchema,
  uuidSchema,
  visitListQuerySchema,
} from "@linq/shared"
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { getSummary } from "../analytics/service.ts"
import type { Principal } from "../auth/middleware.ts"
import type { Deps } from "../deps.ts"
import { getDomain, listDomains } from "../domains/service.ts"
import { archiveLink, createLink, getLink, listLinks, updateLink } from "../links/service.ts"
import { replaceLinkRules } from "../rules/service.ts"
import { listVisits } from "../visits/service.ts"

/** One MCP tool: its input, the claim it needs, and the service call it makes. */
export type McpTool = {
  name: string
  title: string
  description: string
  /**
   * What the calling key must hold for the tool to be listed or run. Null
   * matches REST, where every read is open to any valid key.
   */
  claim: { action: Action; subject: Subject } | null
  inputSchema: z.ZodObject
  annotations: ToolAnnotations
  handler: (deps: Deps, principal: Principal, args: never) => Promise<unknown>
}

/** Types a tool's handler from its own schema, then erases it into the list. */
const tool = <S extends z.ZodObject>(
  t: Omit<McpTool, "inputSchema" | "handler"> & {
    inputSchema: S
    handler: (deps: Deps, principal: Principal, args: z.infer<S>) => Promise<unknown>
  },
): McpTool => t as unknown as McpTool

/**
 * Parses tool arguments through the REST schema, so validation and defaults
 * are the REST endpoint's own. Arrays are joined first: query schemas read
 * lists as comma-separated strings and would drop a JSON array silently.
 */
function asQuery<S extends z.ZodType>(schema: S, args: Record<string, unknown>): z.infer<S> {
  const flat = Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
  )
  const parsed = schema.safeParse(flat)
  if (!parsed.success) throw ApiError.validation("request validation failed", parsed.error.issues)
  return parsed.data
}

const id = z.object({ id: uuidSchema.describe("The link's id.") })
const domainId = z.object({ id: uuidSchema.describe("The domain's id.") })
const page = {
  limit: paginationSchema.shape.limit.describe("Page size, 1 to 200."),
  offset: paginationSchema.shape.offset,
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false }
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }

export const MCP_TOOLS: McpTool[] = [
  tool({
    name: "list_links",
    title: "List links",
    description:
      "Lists short links, newest first by default, with visit totals. Filter by domain, tag, " +
      "status (active by default) or a search over slug, name and destination.",
    claim: null,
    annotations: READ,
    inputSchema: z.object({
      ...page,
      search: z.string().max(200).optional().describe("Matches slug, name or destination."),
      tags: z.array(tagSchema).optional().describe("Links carrying any of these tags."),
      domain_id: z.array(uuidSchema).optional().describe("Links on any of these domains."),
      status: linkListQuerySchema.shape.status,
      sort: linkListQuerySchema.shape.sort,
      order: linkListQuerySchema.shape.order,
      expiry: linkListQuerySchema.shape.expiry,
    }),
    handler: (deps, _p, args) => listLinks(deps, asQuery(linkListQuerySchema, args)),
  }),

  tool({
    name: "get_link",
    title: "Get a link",
    description: "Returns one link by id, with its short URL, destination, tags and visit totals.",
    claim: null,
    annotations: READ,
    inputSchema: id,
    handler: (deps, _p, { id }) => getLink(deps, id),
  }),

  tool({
    name: "create_link",
    title: "Create a link",
    description:
      "Creates a short link on a domain. Omit slug for a generated one. Use list_domains to find " +
      "domain_id. Rules are ordered alternate destinations; the first whose conditions all hold wins.",
    claim: { action: "create", subject: "Link" },
    annotations: WRITE,
    inputSchema: linkCreateSchema,
    handler: (deps, p, args) => createLink(deps, p, args),
  }),

  tool({
    name: "update_link",
    title: "Update a link",
    description:
      "Changes a link's destination, name, description, tags, query forwarding, preset params, " +
      "expiry, listing or rules. Only the fields sent change. Slug and domain cannot change. " +
      "Use archive_link and restore_link to change its status.",
    claim: { action: "update", subject: "Link" },
    annotations: { ...WRITE, idempotentHint: true },
    inputSchema: linkPatchSchema.omit({ status: true }).extend(id.shape),
    handler: (deps, p, { id, ...patch }) => updateLink(deps, p, id, patch),
  }),

  tool({
    name: "archive_link",
    title: "Archive a link",
    description:
      "Archives a link: it stops redirecting but keeps its slug and visits. Reversible with restore_link.",
    claim: { action: "archive", subject: "Link" },
    annotations: { ...WRITE, idempotentHint: true },
    inputSchema: id,
    handler: (deps, p, { id }) => archiveLink(deps, p, id),
  }),

  tool({
    name: "restore_link",
    title: "Restore a link",
    description: "Restores an archived link so it redirects again.",
    claim: { action: "archive", subject: "Link" },
    annotations: { ...WRITE, idempotentHint: true },
    inputSchema: id,
    handler: (deps, p, { id }) => updateLink(deps, p, id, { status: "active" }),
  }),

  tool({
    name: "set_link_rules",
    title: "Replace a link's rules",
    description:
      "Replaces a link's whole ordered rule list. Each rule is an alternate destination plus " +
      "conditions (platform, or a query parameter) that must all hold; the first match wins. " +
      "An empty list removes every rule.",
    claim: { action: "update", subject: "Link" },
    annotations: { ...WRITE, idempotentHint: true },
    inputSchema: id.extend({ rules: rulesPutSchema }),
    handler: (deps, p, { id, rules }) => replaceLinkRules(deps, p, id, rules),
  }),

  tool({
    name: "list_domains",
    title: "List domains",
    description: "Lists the domains links can live on, with how many links each has.",
    claim: null,
    annotations: READ,
    inputSchema: z.object(page),
    handler: (deps, _p, args) => listDomains(deps, asQuery(paginationSchema, args)),
  }),

  tool({
    name: "get_domain",
    title: "Get a domain",
    description: "Returns one domain by id, with its fallback and redirect URLs.",
    claim: null,
    annotations: READ,
    inputSchema: domainId,
    handler: (deps, _p, { id }) => getDomain(deps, id),
  }),

  tool({
    name: "get_stats",
    title: "Get visit stats",
    description:
      "Totals visits (human, bot, orphan) for links or domains over a date range. " +
      "Omit link_id and domain_id for the whole instance.",
    claim: null,
    annotations: READ,
    inputSchema: z.object({
      from: z.iso.date().optional().describe("First day, YYYY-MM-DD. Absent means all time."),
      to: z.iso.date().optional().describe("Last day, YYYY-MM-DD, inclusive. Defaults to today."),
      link_id: z.array(uuidSchema).optional(),
      domain_id: z.array(uuidSchema).optional(),
      bot: z.enum(["true", "false", "any"]).optional().describe("Defaults to any."),
    }),
    handler: (deps, _p, args) => getSummary(deps, asQuery(analyticsSummaryQuerySchema, args)),
  }),

  tool({
    name: "list_visits",
    title: "List visits",
    description:
      "Lists individual visits, newest first: when, platform, OS, browser, referer and the " +
      "destination chosen. Never includes the visitor's IP address.",
    claim: null,
    annotations: READ,
    inputSchema: visitListQuerySchema,
    handler: (deps, _p, args) => listVisits(deps, args),
  }),
]
