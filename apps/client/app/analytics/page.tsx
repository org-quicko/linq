"use client"

import { Suspense, useState } from "react"
import { AnalyticsOverview } from "@/components/analytics-overview"
import { AppShell } from "@/components/app-shell"
import { DomainPicker, PageHeader } from "@/components/patterns"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VisitsCard } from "@/components/visits-card"

/**
 * A single page, matching claude/design/Variant — Domains moved into
 * Settings-html's Analytics mockup, which has no tabs. `AnalyticsOverview`
 * is the mockup's own content (stat cards, chart, breakdown lists); the raw
 * visit log and the missed-links view below it are the old Visits and
 * Orphans tabs' bodies, kept verbatim but no longer behind separate tabs —
 * the mockup doesn't cover them, but nothing here drops that functionality.
 */
export default function AnalyticsPage() {
  return (
    <AppShell>
      {() => (
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-7 py-6">
          <PageHeader title="Analytics" />
          {/* AnalyticsOverview reads ?link_id= via useSearchParams (plans/Plan_31.md
           *  §C3), which needs a Suspense boundary under output: "export". */}
          <Suspense fallback={null}>
            <AnalyticsOverview />
          </Suspense>
          <VisitsSection />
          <OrphansSection />
        </div>
      )}
    </AppShell>
  )
}

/** The raw traffic log, with its own domain filter. */
function VisitsSection() {
  const [domain_id, setDomainId] = useState("")

  return (
    <>
      <StatsPanel
        path="/v1/stats"
        title="Traffic"
        extraParams={{ domain_id: domain_id || undefined }}
      />

      <VisitsCard
        title="Log"
        scope={{ domain_id: domain_id || undefined }}
        extraFilters={<DomainPicker className="w-48" value={domain_id} onChange={setDomainId} />}
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
function OrphansSection() {
  const [domain_id, setDomainId] = useState("")

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Domain</CardTitle>
        </CardHeader>
        <CardContent>
          <DomainPicker className="max-w-sm" value={domain_id} onChange={setDomainId} />
        </CardContent>
      </Card>

      <StatsPanel
        path="/v1/stats"
        title="Missed links"
        initialGroupBy="slug"
        groups={["slug", "day", "platform", "referer"]}
        extraParams={{ orphan: "true", domain_id: domain_id || undefined }}
      />

      <VisitsCard
        title="Missed requests"
        scope={{ orphan: "true", domain_id: domain_id || undefined }}
      />
    </>
  )
}
