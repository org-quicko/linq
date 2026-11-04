import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import type { Env } from "../app/env.ts"
import { createMcpServer } from "./server.ts"

/**
 * The MCP endpoint, Streamable HTTP and stateless: a fresh server and
 * transport per request, no session id, and plain JSON responses rather than
 * an SSE stream. Nothing is kept between requests, so it works unchanged
 * behind any number of linq processes. Authentication and the rate limit run
 * before this, exactly as for /api/v1.
 */
export const mcpRoutes = new Hono<Env>().all("/", async (c) => {
  const server = createMcpServer(c.var, c.var.principal)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(c.req.raw)
  } finally {
    // JSON mode has built the whole response by now, so the server can go.
    await server.close()
  }
})
