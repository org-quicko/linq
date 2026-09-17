"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Picker } from "@/components/common"
import { StatsPanel } from "@/components/stats-panel"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VisitsCard } from "@/components/visits-card"
import { useListDomainsQuery } from "../../lib/store/domains"

/** Radix refuses an item whose value is "", so "no filter" needs a real value. */
const ANY_DOMAIN = "__any__"

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
  const domains = useListDomainsQuery({ limit: 200 })
  const [domainId, setDomainId] = useState("")

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Orphan visits</h1>
        <p className="text-sm text-muted-foreground">
          Requests that hit a live domain but matched no active link.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Domain</CardTitle>
        </CardHeader>
        <CardContent>
          <Picker
            className="max-w-sm"
            value={domainId || ANY_DOMAIN}
            onChange={(value) => setDomainId(value === ANY_DOMAIN ? "" : value)}
            options={[
              { value: ANY_DOMAIN, label: "All domains" },
              ...(domains.data?.data ?? []).map((domain) => ({
                value: domain.id,
                label: domain.host,
              })),
            ]}
          />
        </CardContent>
      </Card>

      <StatsPanel
        path="/v1/stats"
        title="Missed links"
        initialGroupBy="slug"
        groups={["slug", "day", "country", "region", "platform", "referer"]}
        extraParams={{ orphan: "true", domainId: domainId || undefined }}
      />

      <VisitsCard
        title="Missed requests"
        scope={{ orphan: "true", domainId: domainId || undefined }}
      />
    </div>
  )
}
