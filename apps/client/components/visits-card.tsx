"use client"

import { BROWSER_VALUES, type Browser, OS_VALUES, type Os, PLATFORMS, type Platform } from "@linq/shared"
import type { ReactNode } from "react"
import { useEffect, useState } from "react"
import type { Range } from "@/components/common"
import {
  DataTable,
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
/** Radix refuses an item whose value is "", so "no filter" needs a real value. */
const ANY = "__any__"

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
  const [platform, setPlatform] = useState<Platform | "">("")
  const [os, setOs] = useState<Os | "">("")
  const [browser, setBrowser] = useState<Browser | "">("")
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
    platform: platform || undefined,
    os: os || undefined,
    browser: browser || undefined,
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
    "OS",
    "Browser",
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
  const onPlatform = (value: string) => {
    setPlatform(value === ANY ? "" : (value as Platform))
    setOffset(0)
  }
  const onOs = (value: string) => {
    setOs(value === ANY ? "" : (value as Os))
    setOffset(0)
  }
  const onBrowser = (value: string) => {
    setBrowser(value === ANY ? "" : (value as Browser))
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
          <Picker
            className="w-36"
            value={platform || ANY}
            onChange={onPlatform}
            options={[
              { value: ANY, label: "Any platform" },
              ...PLATFORMS.map((p) => ({ value: p, label: p })),
            ]}
          />
          <Picker
            className="w-36"
            value={os || ANY}
            onChange={onOs}
            options={[{ value: ANY, label: "Any OS" }, ...OS_VALUES.map((o) => ({ value: o, label: o }))]}
          />
          <Picker
            className="w-36"
            value={browser || ANY}
            onChange={onBrowser}
            options={[
              { value: ANY, label: "Any browser" },
              ...BROWSER_VALUES.map((b) => ({ value: b, label: b })),
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
                <TableCell>{visit.os ?? "—"}</TableCell>
                <TableCell>{visit.browser ?? "—"}</TableCell>
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
      </CardContent>
    </Card>
  )
}
