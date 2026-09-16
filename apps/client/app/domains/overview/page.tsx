"use client"

import type { StatsBucket } from "@linq/shared"
import { AppShell } from "@/components/app-shell"
import { CardSkeleton, DataTable, QueryState, TableSkeleton, When } from "@/components/common"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { useListDomainsQuery } from "../../../lib/store/domains"
import { useGetStatsQuery } from "../../../lib/store/stats"

const HEAD = ["Host", "Fallback URL", "Active links", "Created"]

/** Sums human and bot clicks across every bucket a stats query returns. */
function sumClicks(buckets: StatsBucket[] | undefined): number {
  return (buckets ?? []).reduce((sum, bucket) => sum + bucket.human + bucket.bot, 0)
}

/** What's live in Domains, and what's landing nowhere, at a glance. */
export default function DomainsOverviewPage() {
  return <AppShell>{() => <DomainsOverview />}</AppShell>
}

function DomainsOverview() {
  // Domains has no status filter or sort of its own, so the one fetch here
  // covers the counts and the recency ranking both.
  const domains = useListDomainsQuery({ limit: 200 })
  const orphanClicks = useGetStatsQuery({ path: "/v1/stats", params: { orphan: "true" } })

  const rows = domains.data?.data ?? []
  const activeCount = rows.filter((domain) => domain.status === "active").length
  const archivedCount = rows.filter((domain) => domain.status === "archived").length
  const recent = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Domains overview</h1>
        <p className="text-sm text-muted-foreground">What's live, and what's landing nowhere.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active domains" value={activeCount} isLoading={domains.isLoading} />
        <Stat label="Archived domains" value={archivedCount} isLoading={domains.isLoading} />
        <Stat
          label="Orphan clicks"
          value={sumClicks(orphanClicks.data)}
          isLoading={orphanClicks.isLoading}
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Recent domains</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState
            isLoading={domains.isLoading}
            isFetching={domains.isFetching}
            error={domains.error}
            empty={recent.length === 0}
            emptyMessage="No domains yet."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {recent.length > 0 ? (
            <DataTable head={HEAD}>
              {recent.map((domain) => (
                <TableRow key={domain.id}>
                  <TableCell className="max-w-xs truncate font-medium">{domain.host}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {domain.fallbackUrl ?? "404 when blank"}
                  </TableCell>
                  <TableCell className="tabular-nums">{domain.linkCount}</TableCell>
                  <TableCell>
                    <When iso={domain.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  isLoading,
}: {
  label: string
  value: number | undefined
  isLoading: boolean
}) {
  if (isLoading) return <CardSkeleton />
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
          {value === undefined ? "—" : value}
        </p>
      </CardContent>
    </Card>
  )
}
