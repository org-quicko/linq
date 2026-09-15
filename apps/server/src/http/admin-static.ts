import { dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Hono } from "hono"
import type { Env } from "./env.ts"

/**
 * The Next.js static export, resolved from this file rather than the working
 * directory so the path holds whether the server is started from the repo root,
 * from apps/server, or from /app inside the image.
 */
export const adminRoot = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "../../../admin/out"),
)

/**
 * Paths under `_next/static` carry a content hash in their name, so they can be
 * cached forever. Everything else is HTML that must not outlive a deploy.
 */
function cacheControl(path: string): string {
  return path.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
}

/**
 * Serves the exported Admin UI at /admin.
 *
 * `trailingSlash` is on in the export, so `/admin/linqs/` maps to
 * `linqs/index.html`; a path without the slash is tried as a file first and then
 * as a directory, which is what makes `/admin/linqs` work too.
 *
 * Must be mounted before the catch-all redirect, or `/admin` would be read as a
 * slug. Returns 404 when no export is present, so a server running without a
 * built UI still serves redirects and the API.
 */
export function mountAdmin(app: Hono<Env>, root: string = adminRoot): void {
  app.get("/admin", (c) => c.redirect("/admin/", 302))

  app.get("/admin/*", async (c) => {
    const relative = c.req.path.slice("/admin".length) || "/"

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
        return c.body(await file.bytes(), 200, { "content-type": file.type })
      }
    }

    const notFound = Bun.file(join(base, "404.html"))
    if (await notFound.exists()) {
      return c.body(await notFound.bytes(), 404, { "content-type": "text/html; charset=utf-8" })
    }
    return c.text("Not Found", 404)
  })
}
