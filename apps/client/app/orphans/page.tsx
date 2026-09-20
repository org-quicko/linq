"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { DomainPicker, PageHeader } from "@/components/patterns"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VisitsCard } from "@/components/visits-card"

/**
 * Visits that resolved to no link: an unknown slug, an archived link, or a bare
 * visit to the domain root.
 *
 * Grouping by requested slug is the point of the page — it is what turns "some
 * traffic is being missed" into "these are the links people are following".
 * Destination is left out of the picker because on this slice it is always the
 * domain's fallback URL.
 */
export default function OrphansPage() {
  return <AppShell>{() => <Orphans />}</AppShell>
}

function Orphans() {
  const [domainId, setDomainId] = useState("")

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Orphan visits"
        description="Requests that hit a live domain but matched no active link."
      />

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
    </div>
  )
}
