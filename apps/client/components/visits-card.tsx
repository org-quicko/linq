"use client"

import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import type { Range } from "@/components/common"
import {
  DataTable,
  GeoAttribution,
  Pager,
  Picker,
  QueryState,
  RangePicker,
  TableSkeleton,
  useRange,
  When,
} from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { useListVisitsQuery } from "../lib/store/visits"

/** What narrows the log. Every field is optional; together they are the scope. */
export type VisitScope = { linkId?: string; domainId?: string; orphan?: "true" }

const PAGE = 25

/**
 * The raw visit log, paginated, for whatever scope it is given.
 *
 * One component serves the page and the link detail card, because the only
 * thing that differs between them is the scope and the filters above the table
 * — which is what `extraFilters` is for.
 */
export function VisitsCard({
  title = "Visits",
  scope,
  extraFilters,
}: {
  title?: string
  scope: VisitScope
  extraFilters?: ReactNode
}) {
  const [bot, setBot] = useState<"any" | "true" | "false">("any")
  const { range, setRange, fromInstant } = useRange()
  const [offset, setOffset] = useState(0)

  // A scope change comes from the parent, so it cannot reset the offset the way
  // the pickers below do — and page 7 of a list that just got shorter is empty.
  const scopeKey = `${scope.linkId ?? ""}|${scope.domainId ?? ""}|${scope.orphan ?? ""}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the dependency
  useEffect(() => setOffset(0), [scopeKey])

  const visits = useListVisitsQuery({
    ...scope,
    bot,
    from: fromInstant,
    limit: PAGE,
    offset,
  })
  const rows = visits.data?.data ?? []
  const total = visits.data?.total ?? 0

  // On a single link every row requested the same slug, so the column would say
  // the same thing all the way down.
  const showSlug = !scope.linkId
  const head = [
    "When",
    ...(showSlug ? ["Slug"] : []),
    "Platform",
    "Location",
    "Referrer",
    "Sent to",
    "",
  ]

  // Changing a filter puts the reader back on the first page; the list under
  // them is a different list now.
  const onBot = (value: string) => {
    setBot(value as typeof bot)
    setOffset(0)
  }
  const onRange = (value: Range) => {
    setRange(value)
    setOffset(0)
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{title}</CardTitle>
        <CardAction className="flex flex-wrap gap-2">
          {extraFilters}
          <Picker
            className="w-40"
            value={bot}
            onChange={onBot}
            options={[
              { value: "any", label: "Everyone" },
              { value: "false", label: "Humans only" },
              { value: "true", label: "Bots only" },
            ]}
          />
          <RangePicker value={range} onChange={onRange} />
        </CardAction>
      </CardHeader>

      <CardContent>
        <QueryState
          isLoading={visits.isLoading}
          isFetching={visits.isFetching}
          error={visits.error}
          empty={rows.length === 0}
          emptyMessage="No visits yet."
          skeleton={<TableSkeleton head={head} />}
        />

        {rows.length > 0 ? (
          <DataTable head={head}>
            {rows.map((visit) => (
              <TableRow key={visit.id}>
                <TableCell>
                  <When iso={visit.occurredAt} />
                </TableCell>
                {showSlug ? (
                  <TableCell className="font-mono text-xs">
                    {visit.slugRequested === "" ? "/" : visit.slugRequested}
                  </TableCell>
                ) : null}
                <TableCell>{visit.platform}</TableCell>
                <TableCell className="text-muted-foreground">
                  {[visit.region, visit.country].filter(Boolean).join(", ") || "—"}
                </TableCell>
                <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                  {visit.referer ?? "—"}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                  <span title={visit.destination ?? ""}>{visit.destination ?? "—"}</span>
                </TableCell>
                <TableCell>{visit.isBot ? <Badge variant="outline">Bot</Badge> : null}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        ) : null}

        <Pager total={total} limit={PAGE} offset={offset} onChange={setOffset} />
        <GeoAttribution />
      </CardContent>
    </Card>
  )
}
