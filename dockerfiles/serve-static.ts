import { isAbsolute, join, relative as relativePath, resolve } from "node:path"

/**
 * Serves a Next.js static export built for a domain root (trailingSlash: true,
 * no basePath) at `/`. Mirrors apps/server/src/http/admin-static.ts, which
 * serves the same kind of export at `/home` inside the combined image — same
 * trailing-slash resolution, same immutable caching for hashed
 * `_next/static` assets, same custom 404.html, same path-traversal guard.
 */
const root = resolve(import.meta.dir, "out-standalone")

function cacheControl(path: string): string {
  return path.includes("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache"
}

Bun.serve({
  async fetch(req) {
    const path = new URL(req.url).pathname

    // Trust boundary: resolve the path, then refuse anything that landed
    // outside the export directory, however it was encoded.
    const target = resolve(root, `.${path}`)
    const inside = relativePath(root, target)
    if (inside.startsWith("..") || isAbsolute(inside)) {
      return new Response("Not Found", { status: 404 })
    }

    const candidates = path.endsWith("/")
      ? [join(target, "index.html")]
      : [target, join(target, "index.html")]

    for (const candidate of candidates) {
      const file = Bun.file(candidate)
      if (await file.exists()) {
        return new Response(file, {
          headers: { "cache-control": cacheControl(candidate.replaceAll("\\", "/")) },
        })
      }
    }

    const notFound = Bun.file(join(root, "404.html"))
    if (await notFound.exists()) {
      return new Response(notFound, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return new Response("Not Found", { status: 404 })
  },
})

console.log(`serving ${root} on :${Bun.env.PORT ?? 3000}`)
