"use client"

import { GROUP_BY, type GroupBy, type StatsBucket } from "@linq/shared"
import { useMemo, useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { Picker, QueryState, RangePicker } from "@/components/common"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useRange } from "@/lib/hooks"
import { useGetStatsQuery } from "../lib/store/stats"

/** Human-readable names for each grouping the stats endpoints accept. */
const GROUP_LABELS: Record<GroupBy, string> = {
  day: "Day",
  platform: "Platform",
  os: "OS",
  browser: "Browser",
  referer: "Referrer",
  destination: "Destination",
  slug: "Requested slug",
}

/** Ranked dimensions beyond this are dropped: a long tail reads as noise. */
const MAX_BARS = 20
/** Days beyond this (only reachable via "All time") are dropped the same way. */
export const MAX_DAYS = 90

/**
 * One bucket per day in the window. The aggregate only returns days that had a
 * visit, which would otherwise draw a gap-free axis that misreads as
 * consecutive days. Exported for the Analytics overview chart
 * (analytics-overview.tsx), which needs the same continuous days.
 */
export function fillDays(buckets: StatsBucket[], from: string | undefined): StatsBucket[] {
  if (buckets.length === 0) return buckets
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  const d = new Date(`${from?.slice(0, 10) ?? buckets[0].key}T00:00:00Z`)
  const end = new Date(`${buckets[buckets.length - 1].key}T00:00:00Z`)
  const out: StatsBucket[] = []
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10)
    out.push(byKey.get(key) ?? { key, human: 0, bot: 0 })
  }
  return out
}

/**
 * Charts one stats endpoint, whichever it is.
 *
 * `path` is the endpoint without its query string, so the same panel serves a
 * link, a domain and the whole instance. `groups` narrows the picker where a
 * grouping would be meaningless, such as destination on the orphan slice.
 *
 * Day is charted as a line chart along the time axis, since dates are short,
 * uniform and consecutive. Every other grouping is charted sideways as a bar chart,
 * one full-width row per entity, because a referrer or slug is too long to sit
 * legibly under a vertical axis.
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
  const [group_by, setGroupBy] = useState<GroupBy>(initialGroupBy)
  const { range, setRange, from } = useRange()
  const horizontal = group_by !== "day"

  const {
    data: stats,
    isLoading,
    isFetching,
    error,
  } = useGetStatsQuery({ path, params: { ...extraParams, group_by, from } })

  const all = stats ?? []

  const buckets = useMemo(() => {
    // Ranked dimensions keep the top N; day keeps the most recent N — the
    // server returns days ascending, so the recent end is the tail.
    const trimmed = horizontal ? all.slice(0, MAX_BARS) : fillDays(all, from).slice(-MAX_DAYS)
    return trimmed.map((bucket) => ({
      ...bucket,
      // An empty key means the dimension was never recorded for those visits.
      key: bucket.key === "" ? "(not recorded)" : bucket.key,
    }))
  }, [all, from, horizontal])

  const totals = all.reduce(
    (sum, bucket) => ({ human: sum.human + bucket.human, bot: sum.bot + bucket.bot }),
    { human: 0, bot: 0 },
  )

  const height = horizontal ? Math.max(220, buckets.length * 34) : 288

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>{title}</CardTitle>
        <CardAction className="flex gap-2">
          <RangePicker value={range} onChange={setRange} />
          <Picker
            className="w-48"
            value={group_by}
            onChange={(value) => setGroupBy(value as GroupBy)}
            options={groups.map((group) => ({ value: group, label: GROUP_LABELS[group] }))}
          />
        </CardAction>
      </CardHeader>

      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          <strong className="text-foreground tabular-nums">{totals.human}</strong> human ·{" "}
          <span className="tabular-nums">{totals.bot}</span> bot
          {buckets.length < all.length ? ` — showing top ${buckets.length} of ${all.length}` : null}
        </p>

        <QueryState
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          empty={buckets.length === 0}
          emptyMessage="No visits recorded yet."
        />

        {buckets.length > 0 ? (
          <div className="w-full" style={{ height }}>
            <ResponsiveContainer width="100%" height="100%">
              {horizontal ? (
                <BarChart
                  data={buckets}
                  layout="vertical"
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  {/* Theme tokens, so the chart follows light and dark with the rest. */}
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    horizontal={false}
                    vertical={true}
                  />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  />
                  <YAxis
                    type="category"
                    dataKey="key"
                    width={160}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickFormatter={(value: string) =>
                      value.length > 22 ? `${value.slice(0, 21)}…` : value
                    }
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      borderColor: "var(--border)",
                      color: "var(--popover-foreground)",
                    }}
                  />
                  <Legend />
                  <Bar dataKey="human" name="Human" fill="var(--chart-1)" radius={[0, 2, 2, 0]} />
                  <Bar dataKey="bot" name="Bot" fill="var(--chart-2)" radius={[0, 2, 2, 0]} />
                </BarChart>
              ) : (
                <LineChart data={buckets} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="key"
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    minTickGap={24}
                    tickFormatter={(value: string) => value.slice(5)}
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
                  <Line
                    type="monotone"
                    dataKey="human"
                    name="Human"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "var(--chart-1)" }}
                    activeDot={{ r: 5 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="bot"
                    name="Bot"
                    stroke="var(--chart-2)"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "var(--chart-2)" }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
