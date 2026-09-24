/**
 * Where this build of the UI is mounted.
 *
 * Two shapes ship from one codebase: a linq server serves the UI at a configured
 * non-root path, and a static host serves it at a domain root. `next.config.ts`
 * reads the same variable for `basePath`, so the two can never disagree.
 *
 * `next/link`, `router.push` and `usePathname` handle the prefix themselves —
 * this is only for `window.location`, which Next does not rewrite. Inlined at
 * build time, like every `NEXT_PUBLIC_*` value.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? ""

/** An in-app path spelled for `window.location`. */
export function appUrl(path: string): string {
  return `${BASE_PATH}${path}`
}
