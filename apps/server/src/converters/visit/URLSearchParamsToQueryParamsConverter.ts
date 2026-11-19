/**
 * The visit's record of what the caller asked for, before any merging.
 * Repeated keys keep every value, in order.
 *
 * @param params - The incoming request's query string.
 * @returns Each key's values, or null when the query is empty.
 */
export class URLSearchParamsToQueryParamsConverter {
  convertFrom(params: URLSearchParams): Record<string, string[]> | null {
    const out: Record<string, string[]> = {}
    for (const [key, value] of params) {
      const seen = out[key]
      if (seen) seen.push(value)
      else out[key] = [value]
    }
    return Object.keys(out).length ? out : null
  }
}
