"use client"

import { Suspense, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { DomainPicker, PageHeader, StatCard, TabShell } from "@/components/patterns"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VisitsCard } from "@/components/visits-card"
import { useListDomainsQuery } from "../../lib/store/domains"
import { useListLinksQuery } from "../../lib/store/links"

/**
 * Overview, Visits and Orphans, as tabs of one page rather than three —
 * merging plans/Plan_27.md Part C1. Each tab's body is its old page's
 * content moved close to verbatim; only the chrome around them changed.
 * Tab state itself is `TabShell` (@/components/patterns), shared with
 * Archives (Part C2).
 */
export default function AnalyticsPage() {
  return (
    // useSearchParams (inside TabShell) needs a Suspense boundary under the App Router.
    <Suspense fallback={<p className="p-8 text-sm text-muted-foreground">Loading…</p>}>
      <AppShell>{() => <Analytics />}</AppShell>
    </Suspense>
  )
}

function Analytics() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Analytics" />

      <TabShell
        basePath="/analytics/"
        defaultTab="overview"
        tabs={[
          { value: "overview", label: "Overview", content: <OverviewTab /> },
          { value: "visits", label: "Visits", content: <VisitsTab /> },
          { value: "orphans", label: "Orphans", content: <OrphansTab /> },
        ]}
      />
    </div>
  )
}

/**
 * Three totals — a single `limit=1` request is the cheapest way to read an
 * unfiltered count without a counting endpoint that exists for nothing else
 * — plus the whole instance's traffic.
 */
function OverviewTab() {
  const links = useListLinksQuery({ limit: 1 })
  const archived = useListLinksQuery({ limit: 1, status: "archived" })
  const domains = useListDomainsQuery({ limit: 1 })

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Active links" value={links.data?.total} isLoading={links.isLoading} />
        <StatCard
          label="Archived links"
          value={archived.data?.total}
          isLoading={archived.isLoading}
        />
        <StatCard label="Domains" value={domains.data?.total} isLoading={domains.isLoading} />
      </div>

      <StatsPanel path="/v1/stats" title="Visits" />
    </>
  )
}

/**
 * The raw traffic log, with its own domain filter — independent of Orphans'
 * below, the same way the two were independent pages before this merge.
 */
function VisitsTab() {
  const [domainId, setDomainId] = useState("")

  return (
    <>
      <StatsPanel
        path="/v1/stats"
        title="Traffic"
        extraParams={{ domainId: domainId || undefined }}
      />

      <VisitsCard
        title="Log"
        scope={{ domainId: domainId || undefined }}
        extraFilters={<DomainPicker className="w-48" value={domainId} onChange={setDomainId} />}
      />
    </>
  )
}

/**
 * Visits that resolved to no link: an unknown slug, an archived link, or a
 * bare visit to the domain root. Grouping by requested slug is the point —
 * it turns "some traffic is being missed" into "these are the links people
 * are following". Destination is left out of the picker because on this
 * slice it is always the domain's fallback URL.
 */
function OrphansTab() {
  const [domainId, setDomainId] = useState("")

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Domain</CardTitle>
        </CardHeader>
        <CardContent>
          <DomainPicker className="max-w-sm" value={domainId} onChange={setDomainId} />
        </CardContent>
      </Card>

      <StatsPanel
        path="/v1/stats"
        title="Missed links"
        initialGroupBy="slug"
        groups={["slug", "day", "platform", "referer"]}
        extraParams={{ orphan: "true", domainId: domainId || undefined }}
      />

      <VisitsCard
        title="Missed requests"
        scope={{ orphan: "true", domainId: domainId || undefined }}
      />
    </>
  )
}
