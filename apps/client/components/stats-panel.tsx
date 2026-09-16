"use client"

import { GROUP_BY, type GroupBy, type StatsBucket } from "@linq/shared"
import { useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { GeoAttribution, Picker, QueryState } from "@/components/common"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { qs } from "../lib/api"
import { useApi } from "../lib/use-api"

/** Human-readable names for each grouping the stats endpoints accept. */
const GROUP_LABELS: Record<GroupBy, string> = {
  day: "Day",
  country: "Country",
  region: "Region",
  platform: "Platform",
  referer: "Referrer",
  destination: "Destination",
  slug: "Requested slug",
}

/** Bars beyond this are dropped: a long tail of referrers reads as noise. */
const MAX_BARS = 20

/**
 * Charts one stats endpoint, whichever it is.
 *
 * `path` is the endpoint without its query string, so the same panel serves a
 * link, a domain and the whole instance. `groups` narrows the picker where a
 * grouping would be meaningless, such as destination on the orphan slice.
 */
export function StatsPanel({
  path,
  title,
  groups = GROUP_BY,
  initialGroupBy = "day",
  extraParams = {},
}: {
  path: string
  title: string
  groups?: readonly GroupBy[]
  initialGroupBy?: GroupBy
  extraParams?: Record<string, string | undefined>
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>(initialGroupBy)
  const stats = useApi<StatsBucket[]>(`${path}${qs({ ...extraParams, groupBy })}`)

  const buckets = (stats.data ?? []).slice(0, MAX_BARS).map((bucket) => ({
    ...bucket,
    // An empty key means the dimension was never recorded for those clicks.
    key: bucket.key === "" ? "(not recorded)" : bucket.key,
  }))

  const totals = (stats.data ?? []).reduce(
    (sum, bucket) => ({ human: sum.human + bucket.human, bot: sum.bot + bucket.bot }),
    { human: 0, bot: 0 },
  )

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Picker
            className="w-48"
            value={groupBy}
            onChange={(value) => setGroupBy(value as GroupBy)}
            options={groups.map((group) => ({ value: group, label: GROUP_LABELS[group] }))}
          />
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          <strong className="text-foreground tabular-nums">{totals.human}</strong> human ·{" "}
          <span className="tabular-nums">{totals.bot}</span> bot
        </p>

        <QueryState
          loading={stats.loading}
          error={stats.error}
          empty={buckets.length === 0}
          emptyMessage="No clicks recorded yet."
        />

        {buckets.length > 0 ? (
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                {/* Theme tokens, so the chart follows light and dark with the rest. */}
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="key"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  interval="preserveStartEnd"
                  tickFormatter={(value: string) =>
                    value.length > 18 ? `${value.slice(0, 17)}…` : value
                  }
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  width={36}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--popover)",
                    borderColor: "var(--border)",
                    color: "var(--popover-foreground)",
                  }}
                />
                <Legend />
                <Bar dataKey="human" name="Human" stackId="clicks" fill="var(--chart-1)" />
                <Bar dataKey="bot" name="Bot" stackId="clicks" fill="var(--chart-2)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        <GeoAttribution />
      </CardContent>
    </Card>
  )
}
