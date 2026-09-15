import { isbot } from "isbot"

/** A request with no User-Agent at all is not a browser, so it counts as a bot. */
export function detectBot(userAgent: string | null | undefined): boolean {
  return !userAgent || isbot(userAgent)
}
