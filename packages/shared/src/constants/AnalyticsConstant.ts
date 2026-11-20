/** What a breakdown groups by. `day` is not here: it is its own endpoint,
 *  the only one that comes back chronologically and the only one a chart
 *  plots. */
export const ANALYTICS_DIMENSIONS = [
  "referer",
  "os",
  "browser",
  "platform",
  "slug",
  "destination",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "device_type",
] as const

/** What a report can be narrowed by — a subset. Every one of these forces
 *  the read off the rollup (resources/docs/adr/0015), which is why the set is
 *  deliberately smaller than the dimensions. */
export const ANALYTICS_FILTERS = [
  "referer",
  "os",
  "browser",
  "platform",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "device_type",
] as const

/** The rollup stores '' where a dimension was never recorded — an absent
 *  referer, an OS the parser could not name. '' cannot survive a CSV round
 *  trip, so this is its wire spelling. Not a possible host, OS or browser
 *  name, so it cannot collide. */
export const NOT_RECORDED = "(none)"

/** One year. Enforced only where it bites: a window over the rollup is what
 *  the rollup is for; a window over the visit log is the scan a filtered
 *  report has to run — bounded so it stays cheap. */
export const MAX_RANGE_DAYS = 366

/** How wide one timeseries bucket is. A bucket's key is the UTC date its
 *  period starts on: the day itself, the Monday of its ISO week, or the first
 *  of its month. The first bucket can therefore start before `from`; it still
 *  counts only visits inside the window. */
export const ANALYTICS_GRANULARITIES = ["day", "week", "month"] as const
