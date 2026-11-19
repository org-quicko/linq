/** Paths linq answers itself; they can never be slugs. */
export const RESERVED_SLUGS = new Set([
  "api",
  "home",
  "health",
  "robots.txt",
  "favicon.ico",
  "llms.txt",
])

export const SLUG_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
