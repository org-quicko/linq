import { ApiError } from "@linq/shared"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import pkg from "../../package.json" with { type: "json" }
import type { Principal } from "../auth/middleware.ts"
import type { Deps } from "../deps.ts"
import { reqLog, span } from "../infra/log.ts"
import { MCP_TOOLS, type McpTool } from "./tools.ts"

const json = (data: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
})

const permits = (principal: Principal, t: McpTool) =>
  t.claim === null || principal.ability.can(t.claim.action, t.claim.subject)

/**
 * One tool call, with the error rules `app.onError` applies to REST: an
 * `ApiError` comes back as the same JSON envelope REST would send, so the
 * model can read and correct it; anything else is logged once and reported
 * without detail, so internals never reach the client.
 */
async function run(t: McpTool, deps: Deps, principal: Principal, args: unknown): Promise<CallToolResult> {
  // Unlisted tools cannot be called anyway; this keeps the gate from
  // depending on registration alone.
  if (!permits(principal, t)) return json(ApiError.forbidden().toBody(), true)
  try {
    return json(await span(`mcp.${t.name}`, () => t.handler(deps, principal, args as never)))
  } catch (err) {
    if (err instanceof ApiError) return json(err.toBody(), true)
    reqLog().error({ err, tool: t.name }, "unhandled tool error")
    return json(new ApiError("internal", "internal server error").toBody(), true)
  }
}

/**
 * An MCP server for one authenticated key, holding only the tools its claims
 * permit, so `tools/list` shows exactly what it may do. Built per request:
 * the endpoint is stateless, and a key's claims can change between requests.
 */
export function createMcpServer(deps: Deps, principal: Principal): McpServer {
  const server = new McpServer(
    { name: "linq", version: pkg.version },
    {
      instructions:
        "Tools for a self-hosted linq instance: short links on your own domains, with visit analytics. " +
        "A link is a slug on a domain that redirects to a destination; rules send some visitors elsewhere. " +
        "Archiving is reversible; nothing here deletes anything. Only the tools this API key may use are listed.",
    },
  )
  for (const t of MCP_TOOLS) {
    if (!permits(principal, t)) continue
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      (args: unknown) => run(t, deps, principal, args),
    )
  }
  return server
}
