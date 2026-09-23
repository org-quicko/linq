import type { NextConfig } from "next"

/** `next dev` serves the app itself; the export never runs a Node process. */
const isDev = process.env.NODE_ENV === "development"

/**
 * Where this build is mounted. Two shapes ship from one codebase:
 *
 * - a configured non-root path, for the export a linq server serves alongside its API.
 * - empty, for a static host that serves the UI at a domain root.
 *
 * `lib/base-path.ts` reads the same variable for the handful of
 * `window.location` navigations Next does not rewrite, so the two cannot drift.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? process.env.LINQ_CLIENT_BASE_PATH ?? "/home"

/**
 * A static export with no server of its own. Every call it makes goes to a
 * server the user added, at an absolute URL, with a Bearer key — so the UI never
 * depends on which origin is serving it, and development talks to the API
 * cross-origin exactly as production does.
 */
const config: NextConfig = {
  output: isDev ? undefined : "export",
  // `lib/base-path.ts` reads this exact public value. Supplying it here keeps
  // that client-side constant aligned when the default was chosen above.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  ...(basePath ? { basePath } : {}),
  trailingSlash: true,
  images: { unoptimized: true },
  ...(isDev && basePath
    ? {
        // :3001 serves nothing but the Client UI, so its bare root is a dead end
        // that would otherwise 404. Only needed when a basePath moves the app
        // off the root; in production this path belongs to the domain's
        // fallback URL.
        async redirects() {
          return [{ source: "/", destination: `${basePath}/`, permanent: false, basePath: false }]
        },
      }
    : {}),
}

export default config
