import { ApiError } from "@linq/shared"
import { createMiddleware } from "hono/factory"
import type { Env } from "../http/env.ts"

type Window = { count: number; resetAt: number }

/**
 * A small per-process guard for authenticated API traffic. It deliberately
 * keys on the verified API-key id, never an untrusted forwarding header.
 * Deployments with multiple instances should retain an edge limit as well.
 */
export function limitByKey(maxRequests: number, windowMs = 60_000) {
  const windows = new Map<string, Window>()
  let nextSweep = 0

  return createMiddleware<Env>(async (c, next) => {
    const now = Date.now()
    if (now >= nextSweep) {
      for (const [keyId, window] of windows) {
        if (window.resetAt <= now) windows.delete(keyId)
      }
      nextSweep = now + windowMs
    }

    const keyId = c.var.principal.keyId
    const existing = windows.get(keyId)
    const window =
      !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing
    if (window.count >= maxRequests) {
      c.header("retry-after", String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))))
      throw ApiError.rateLimited("API rate limit exceeded")
    }

    window.count++
    windows.set(keyId, window)
    await next()
  })
}
