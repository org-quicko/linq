import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context, Hono } from "hono"
import { clientPath, isAppHost } from "../config.ts"
import type { Env } from "./env.ts"

/**
 * The Next.js static export, resolved from this file rather than the working
 * directory so the path holds whether the server is started from the repo root,
 * from apps/server, or from /app inside the image.
 */
export const adminRoot = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "../../../client/out"),
)

/**
 * Paths under `_next/static` carry a content hash in their name, so they can be
 * cached forever. Everything else is HTML that must not outlive a deploy.
 */
function cacheControl(path: string): string {
  return path.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
}

/** Hash the inline Next bootstrap blocks per exported document, so CSP can
 * allow exactly the build's scripts without allowing arbitrary inline script. */
function inlineScriptHashes(html: string): string[] {
  const pattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi
  const hashes: string[] = []
  for (const match of html.matchAll(pattern)) {
    if (/\bsrc\s*=/i.test(match[0])) continue
    hashes.push(
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
    )
  }
  return [...new Set(hashes)]
}

function setAdminSecurityHeaders(c: Context<Env>, html: string) {
  const scriptHashes = inlineScriptHashes(html)
  c.header(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `script-src 'self' ${scriptHashes.join(" ")}`,
      // Next's static export uses inline style attributes. They are not a
      // script-execution sink; preserving them keeps every exported route
      // rendering while script execution remains hash-restricted.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: http:",
    ].join("; "),
  )
  c.header("x-content-type-options", "nosniff")
  c.header("x-frame-options", "DENY")
  c.header("referrer-policy", "strict-origin-when-cross-origin")
  c.header("permissions-policy", "camera=(), geolocation=(), microphone=()")
}

/**
 * Serves the exported Client UI at its configured base path.
 *
 * `trailingSlash` is on in the export, so `<basePath>/links/` maps to
 * `links/index.html`; a path without the slash is tried as a file first and then
 * as a directory, which is what makes `<basePath>/links` work too.
 *
 * Must be mounted before the catch-all redirect, or the first path segment
 * would be read as a slug. Returns 404 when no export is present, so a server
 * running without a built UI still serves redirects and the API.
 *
 * With LINQ_APP_HOST set, every other host falls through to the redirect
 * handler, which is what lets a root mount (`/`) coexist with slugs.
 */
export function mountAdmin(
  app: Hono<Env>,
  { basePath, root = adminRoot }: { basePath: string; root?: string },
): void {
  const onThisHost = (c: Context<Env>) =>
    !c.var.config.LINQ_APP_HOST ||
    isAppHost(c.var.config, c.req.header("host") ?? new URL(c.req.url).host)

  if (basePath !== "/") {
    app.get(basePath, (c, next) => (onThisHost(c) ? c.redirect(`${basePath}/`, 302) : next()))
  }

  app.get(clientPath(basePath, "/*"), async (c, next) => {
    if (!onThisHost(c)) return next()
    const relative = basePath === "/" ? c.req.path : c.req.path.slice(basePath.length) || "/"

    // Trust boundary: resolve the path, then refuse anything that landed outside
    // the export directory, however it was encoded. `relative` handles the
    // separator differences so this holds on Windows too.
    const base = resolve(root)
    const target = resolve(base, `.${relative}`)
    const inside = relativePath(base, target)
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return c.text("Not Found", 404)
    }

    const candidates = relative.endsWith("/")
      ? [join(target, "index.html")]
      : [target, join(target, "index.html")]

    for (const candidate of candidates) {
      const file = Bun.file(candidate)
      if (await file.exists()) {
        c.header("cache-control", cacheControl(candidate.replaceAll("\\", "/")))
        if (file.type.startsWith("text/html")) {
          const html = await file.text()
          setAdminSecurityHeaders(c, html)
          return c.body(html, 200, { "content-type": file.type })
        }
        return c.body(await file.bytes(), 200, { "content-type": file.type })
      }
    }

    const notFound = Bun.file(join(base, "404.html"))
    if (await notFound.exists()) {
      const html = await notFound.text()
      setAdminSecurityHeaders(c, html)
      return c.body(html, 404, { "content-type": "text/html; charset=utf-8" })
    }
    return c.text("Not Found", 404)
  })
}
