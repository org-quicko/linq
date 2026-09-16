"use client"

import type { Domain, Link as LinkRecord, Page } from "@linq/shared"
import { AppShell } from "@/components/app-shell"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent } from "@/components/ui/card"
import { useApi } from "../../lib/use-api"

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
  const links = useApi<Page<LinkRecord>>("/v1/links?limit=1")
  const archived = useApi<Page<LinkRecord>>("/v1/links?limit=1&status=archived")
  const domains = useApi<Page<Domain>>("/v1/domains?limit=1")

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Everything on this server, at a glance.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active links" value={links.data?.total} />
        <Stat label="Archived links" value={archived.data?.total} />
        <Stat label="Domains" value={domains.data?.total} />
      </div>

      <StatsPanel path="/v1/stats" title="Clicks" />
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
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
