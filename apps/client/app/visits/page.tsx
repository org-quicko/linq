"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { DomainPicker, PageHeader } from "@/components/patterns"
import { StatsPanel } from "@/components/stats-panel"
import { VisitsCard } from "@/components/visits-card"

/**
 * Every visit this server has recorded, as a chart over the rollup and as the
 * rows behind it.
 *
 * The two read different tables — pre-counted days above, the raw log below —
 * and each keeps its own window, because one is answering "how much" and the
 * other "what exactly".
 */
export default function VisitsPage() {
  return <AppShell>{() => <Visits />}</AppShell>
}

function Visits() {
  const [domainId, setDomainId] = useState("")

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Visits"
        description="Every request this server has answered, newest first."
      />

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
    </div>
  )
}
