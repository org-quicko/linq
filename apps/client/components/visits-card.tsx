"use client"

import { PLATFORMS, type Platform } from "@linq/shared"
import type { ChangeEvent, ReactNode } from "react"
import { useEffect, useState } from "react"
import {
  DataTable,
  Pager,
  Picker,
  QueryState,
  RangePicker,
  TableSkeleton,
  When,
} from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { type Range, useRange } from "@/lib/hooks"
import { useListVisitsQuery } from "../lib/store/visits"

/** What narrows the log. Every field is optional; together they are the scope. */
export type VisitScope = { link_id?: string; domain_id?: string; orphan?: "true" }

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
  // Open vocabulary (ua-parser-js/isbot, not a closed enum like platform), so
  // these are free text rather than a dropdown that couldn't list every value.
  const [os, setOs] = useState("")
  const [browser, setBrowser] = useState("")
  const { range, setRange, fromInstant } = useRange()
  const [offset, setOffset] = useState(0)

  // A scope change comes from the parent, so it cannot reset the offset the way
  // the pickers below do — and page 7 of a list that just got shorter is empty.
  const scopeKey = `${scope.link_id ?? ""}|${scope.domain_id ?? ""}|${scope.orphan ?? ""}`
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
  const showSlug = !scope.link_id
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
  /** Same reset-the-page behaviour as `onBot`/`onPlatform`, for a free-text filter. */
  const onText = (setter: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value)
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
          <Input className="w-28" placeholder="OS" value={os} onChange={onText(setOs)} />
          <Input
            className="w-28"
            placeholder="Browser"
            value={browser}
            onChange={onText(setBrowser)}
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
                  <When iso={visit.occurred_at} />
                </TableCell>
                {showSlug ? (
                  <TableCell className="font-mono text-xs">
                    {visit.slug_requested === "" ? "/" : visit.slug_requested}
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
                <TableCell>{visit.is_bot ? <Badge variant="outline">Bot</Badge> : null}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        ) : null}

        <Pager total={total} limit={PAGE} offset={offset} onChange={setOffset} />
      </CardContent>
    </Card>
  )
}
