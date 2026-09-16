"use client"

import type { StatsBucket } from "@linq/shared"
import NextLink from "next/link"
import { AppShell } from "@/components/app-shell"
import {
  CardSkeleton,
  CopyButton,
  DataTable,
  QueryState,
  TableSkeleton,
  When,
} from "@/components/common"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { qs } from "../../../lib/api"
import { useListLinksQuery } from "../../../lib/store/links"
import { useGetStatsQuery } from "../../../lib/store/stats"

const HEAD = ["Short URL", "Destination", "Clicks", "Created"]

/** Sums human and bot clicks across every bucket a stats query returns. */
function sumClicks(buckets: StatsBucket[] | undefined): number {
  return (buckets ?? []).reduce((sum, bucket) => sum + bucket.human + bucket.bot, 0)
}

/** What's live in Links, and what people are doing with it, at a glance. */
export default function LinksOverviewPage() {
  return <AppShell>{() => <LinksOverview />}</AppShell>
}

function LinksOverview() {
  const links = useListLinksQuery({ limit: 5 })
  const allClicks = useGetStatsQuery({ path: "/v1/stats" })
  const orphanClicks = useGetStatsQuery({ path: "/v1/stats", params: { orphan: "true" } })
  const recent = links.data?.data ?? []

  const orphanTotal = orphanClicks.data ? sumClicks(orphanClicks.data) : undefined
  const linkClicks =
    allClicks.data && orphanTotal !== undefined
      ? sumClicks(allClicks.data) - orphanTotal
      : undefined

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Links overview</h1>
        <p className="text-sm text-muted-foreground">What's live, and what people are clicking.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active links" value={links.data?.total} isLoading={links.isLoading} />
        <Stat label="Clicks on links" value={linkClicks} isLoading={allClicks.isLoading} />
        <Stat label="Orphan clicks" value={orphanTotal} isLoading={orphanClicks.isLoading} />
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Recent links</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryState
            isLoading={links.isLoading}
            isFetching={links.isFetching}
            error={links.error}
            empty={recent.length === 0}
            emptyMessage="No active links yet."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {recent.length > 0 ? (
            <DataTable head={HEAD}>
              {recent.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className="max-w-xs">
                    <div className="flex items-center gap-1">
                      <NextLink
                        href={`/links/detail/${qs({ id: link.id })}`}
                        className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
                      >
                        {link.domainHost}/{link.slug}
                      </NextLink>
                      <CopyButton value={link.shortUrl} />
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    <span title={link.destination}>{link.destination}</span>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {link.humanClicks}
                    <span className="text-muted-foreground"> + {link.botClicks} bot</span>
                  </TableCell>
                  <TableCell>
                    <When iso={link.createdAt} />
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({
  label,
  value,
  isLoading,
}: {
  label: string
  value: number | undefined
  isLoading: boolean
}) {
  if (isLoading) return <CardSkeleton />
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
