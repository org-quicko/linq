import type { NextConfig } from "next"

/** `next dev` needs a live API to talk to; the export never does. */
const isDev = process.env.NODE_ENV === "development"

/** Where `next dev` proxies /api to. The server's own port, by default. */
const devApi = process.env.LINQ_DEV_API ?? "http://localhost:3000"

/**
 * A static export served by Hono at /admin. No Node runtime ships with the
 * Admin UI; every call it makes goes to /api/v1 with a Bearer key.
 *
 * In development the export is switched off so that `rewrites` works, which is
 * what lets the UI on :3001 reach the API on :3000 without CORS. Production
 * never uses the rewrite: there, one process serves both.
 */
const config: NextConfig = {
  output: isDev ? undefined : "export",
  basePath: "/admin",
  trailingSlash: true,
  images: { unoptimized: true },
  ...(isDev
    ? {
        async rewrites() {
          // basePath: false, or the source would become /admin/api/:path* while
          // lib/api.ts calls /api from the browser, which basePath never touches.
          return [{ source: "/api/:path*", destination: `${devApi}/api/:path*`, basePath: false }]
        },
        // :3001 serves nothing but the Admin UI, so its bare root is a dead end
        // that would otherwise 404. Dev only: in production the same path is the
        // server's own root, where it belongs to the domain's fallback URL.
        async redirects() {
          return [{ source: "/", destination: "/admin/", permanent: false, basePath: false }]
        },
      }
    : {}),
}

export default config
