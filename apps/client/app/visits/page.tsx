"use client"

import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Picker } from "@/components/common"
import { StatsPanel } from "@/components/stats-panel"
import { VisitsCard } from "@/components/visits-card"
import { useListDomainsQuery } from "../../lib/store/domains"

/** Radix refuses an item whose value is "", so "no filter" needs a real value. */
const ANY_DOMAIN = "__any__"

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
  const domains = useListDomainsQuery({ limit: 200 })
  const [domainId, setDomainId] = useState("")

  const domainPicker = (
    <Picker
      className="w-48"
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
  )

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Visits</h1>
        <p className="text-sm text-muted-foreground">
          Every request this server has answered, newest first.
        </p>
      </div>

      <StatsPanel
        path="/v1/stats"
        title="Traffic"
        extraParams={{ domainId: domainId || undefined }}
      />

      <VisitsCard
        title="Log"
        scope={{ domainId: domainId || undefined }}
        extraFilters={domainPicker}
      />
    </div>
  )
}
