"use client"

import { Suspense } from "react"
import { AnalyticsOverview } from "@/components/analytics-overview"
import { AppShell } from "@/components/app-shell"

export default function AnalyticsPage() {
  return (
    <AppShell>
      {() => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-7 py-6">
            <Suspense fallback={null}>
              <AnalyticsOverview />
            </Suspense>
          </div>
        </div>
      )}
    </AppShell>
  )
}
