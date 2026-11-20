/** Date bounds for range filters, computed in UTC. */
export class DateTimeUtil {
  /**
   * The instant a lower bound starts at: as given when it carries a time,
   * otherwise that date's UTC midnight.
   *
   * @param value - An ISO date or date-time.
   * @returns The instant.
   */
  static startOfBound(value: string): Date {
    return new Date(value.includes("T") ? value : `${value}T00:00:00Z`)
  }

  /**
   * The UTC midnight after a bare date: the exclusive end of that day, computed
   * here as an instant. `${date}::date + 1` would be cast to timestamptz in the
   * session's TimeZone, cutting the day short (or running it long) on a non-UTC
   * database.
   *
   * @param date - An ISO date, `YYYY-MM-DD`.
   * @returns The first instant of the following UTC day.
   */
  static nextUtcMidnight(date: string): Date {
    return new Date(Date.parse(`${date}T00:00:00Z`) + DateTimeUtil.DAY_MS)
  }

  /** One day, in milliseconds. */
  private static readonly DAY_MS = 86_400_000
}
