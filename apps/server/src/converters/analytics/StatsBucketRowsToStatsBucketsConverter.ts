import type { StatsBucket, StatsBucketRow } from "@linq/shared"

/**
 * Maps grouped count rows to the buckets the API returns. `sum()` comes back
 * from Postgres as a numeric string; the API promises numbers.
 *
 * @param rows - Rows grouped by `key`, with human and bot counts.
 * @returns The API `StatsBucket`s, in the same order.
 */
export class StatsBucketRowsToStatsBucketsConverter {
  convertFrom(rows: StatsBucketRow[]): StatsBucket[] {
    return rows.map((row) => ({ ...row, human: Number(row.human), bot: Number(row.bot) }))
  }
}
