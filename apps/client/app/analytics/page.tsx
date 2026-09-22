"use client"

import { Suspense } from "react"
import { AnalyticsOverview } from "@/components/analytics-overview"
import { AppShell } from "@/components/app-shell"
import { PageHeader } from "@/components/patterns"

export default function AnalyticsPage() {
  return (
    <AppShell>
      {() => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 px-7 pt-6 pb-4">
            <PageHeader title="Analytics" />
          </div>
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-7 pb-6">
            <Suspense fallback={null}>
              <AnalyticsOverview />
            </Suspense>
          </div>
        </div>
      )}
    </AppShell>
  )
}
