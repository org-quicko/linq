/** Link helpers shared by the API and the Client UI. */
export class LinkUtil {
  /**
   * A stable, no-network fallback for links whose creator did not provide a
   * title and whose destination does not expose one. `destination` has already
   * passed `urlSchema` at every call site, so parsing it here is safe.
   */
  static destinationTitle(destination: string): string {
    return new URL(destination).host
  }
}
