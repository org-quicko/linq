"use client"

import { AppShell } from "@/components/app-shell"
import { CardSkeleton } from "@/components/common"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent } from "@/components/ui/card"
import { useListDomainsQuery } from "../../lib/store/domains"
import { useListLinksQuery } from "../../lib/store/links"

/**
 * Where a connected server opens: what it holds, and what it has been doing.
 *
 * The totals ask for a single row each. `Page<T>` carries the unfiltered count
 * in `total`, so a `limit=1` request is the cheapest way to read it without a
 * counting endpoint that exists for nothing else.
 */
export default function OverviewPage() {
  return <AppShell>{() => <Overview />}</AppShell>
}

function Overview() {
  const links = useListLinksQuery({ limit: 1 })
  const archived = useListLinksQuery({ limit: 1, status: "archived" })
  const domains = useListDomainsQuery({ limit: 1 })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Everything on this server, at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active links" value={links.data?.total} isLoading={links.isLoading} />
        <Stat label="Archived links" value={archived.data?.total} isLoading={archived.isLoading} />
        <Stat label="Domains" value={domains.data?.total} isLoading={domains.isLoading} />
      </div>

      <StatsPanel path="/v1/stats" title="Clicks" />
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
