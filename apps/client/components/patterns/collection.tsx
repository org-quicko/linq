"use client"

import type { ReactNode } from "react"
import { DataTable, QueryState, TableSkeleton } from "@/components/common"

/** The shape every RTK Query list hook returns, and the only part `Collection` needs. */
type QueryLike = {
  isLoading: boolean
  isFetching?: boolean
  error?: { message?: string } | null
}

/**
 * Owns the loading/error/empty/rows seam every list page repeated by hand:
 * `<QueryState .../>` immediately followed by
 * `{rows.length > 0 ? <DataTable head={HEAD}>…</DataTable> : null}`, six
 * times across Links, Domains, Keys and both trash pages.
 *
 * Two render shapes, chosen with `variant`: `"table"` wraps rows in
 * `DataTable` (needs `head`), for the pages that still use one; `"list"`
 * wraps them in a plain vertical stack, for `RowCard`-shaped rows. Moving a
 * page from a table to row cards is then a `variant` flip and a change to
 * what `children` returns, not a rewrite of the loading/empty/error scaffolding.
 */
export function Collection<T>({
  query,
  rows,
  variant = "table",
  head,
  emptyMessage = "Nothing here yet.",
  children,
}: {
  query: QueryLike
  rows: T[]
  variant?: "table" | "list"
  /** Required when `variant` is `"table"`. */
  head?: ReactNode[]
  emptyMessage?: string
  children: (row: T) => ReactNode
}) {
  const asTable = variant === "table" && head

  return (
    <>
      <QueryState
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        error={query.error}
        empty={rows.length === 0}
        emptyMessage={emptyMessage}
        skeleton={asTable ? <TableSkeleton head={head} /> : undefined}
      />

      {rows.length > 0 ? (
        asTable ? (
          <DataTable head={head}>{rows.map(children)}</DataTable>
        ) : (
          <div className="flex flex-col gap-2">{rows.map(children)}</div>
        )
      ) : null}
    </>
  )
}
