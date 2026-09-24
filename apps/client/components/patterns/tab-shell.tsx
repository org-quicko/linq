"use client"

import { useRouter, useSearchParams } from "next/navigation"
import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * Tabs whose active one lives in `?tab=`, so it is linkable and survives a
 * reload — the pattern `/links/detail/` already established for this static
 * export's query-string state, now shared by Analytics (Part C1) and
 * Archives (Part C2) instead of each hand-rolling its own copy.
 *
 * `content` is a plain element per tab, built in the caller's render, not a
 * lazy render function — that is safe here because Radix's `TabsContent`
 * does not mount an inactive tab's children at all (no `forceMount` is
 * passed anywhere in this app), so a tab's own queries do not fire until it
 * is actually opened, the same as if it had been written by hand.
 */
export function TabShell<T extends string>({
  tabs,
  defaultTab,
  basePath,
}: {
  tabs: { value: T; label: string; content: ReactNode }[]
  defaultTab: T
  /** The page's own path, e.g. "/analytics/" — builds the ?tab= URL. */
  basePath: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get("tab")
  const active = (tabs.some((tab) => tab.value === requested) ? requested : defaultTab) as T

  return (
    <Tabs value={active} onValueChange={(next) => router.replace(`${basePath}?tab=${next}`)}>
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value} className="flex flex-col gap-4">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  )
}
