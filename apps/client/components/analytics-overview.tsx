"use client"

import type { StatsBucket } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import type { LucideIcon } from "lucide-react"
import { ChevronDown, Globe, Link2, Monitor, Smartphone } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import type { ReactNode } from "react"
import { useEffect, useMemo, useState } from "react"
import { RangePicker } from "@/components/common"
import { LinkFilter } from "@/components/patterns"
import { fillDays, MAX_DAYS } from "@/components/stats-panel"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useRange } from "@/lib/hooks"
import { useGetLinkQuery } from "../lib/store/links"
import { useGetStatsQuery } from "../lib/store/stats"

type DeviceView = "platform" | "os" | "browser"

/**
 * The Analytics overview: a total-visits stat row, a "visits over time"
 * chart, and Referrer / Device breakdown lists — matching
 * claude/design/Variant — Domains moved into Settings-html's Analytics
 * mockup. Picking a link scopes the whole thing to that link's own traffic
 * via `/v1/links/:id/stats` instead of the instance-wide `/v1/stats`.
 *
 * The mockup's per-row "click a breakdown row to filter the whole view by
 * that segment" interaction needs a server-side filter (e.g. `referer=`) the
 * stats endpoints don't accept today, so the rows here are read-only.
 */
export function AnalyticsOverview() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlLinkId = searchParams.get("link_id") ?? ""
  const [link_id, setLinkId] = useState(urlLinkId)
  // `link_name` is not carried in the URL, so a deep link resolves it here —
  // `skipToken` is the pattern `link-form-dialog.tsx` already uses for "no id yet".
  const linked = useGetLinkQuery(urlLinkId || skipToken)
  const [link_name, setLinkName] = useState("")
  const { range, setRange, from } = useRange()
  const path = link_id ? `/v1/links/${link_id}/stats` : "/v1/stats"

  useEffect(() => {
    if (linked.data) setLinkName(linked.data.name ?? linked.data.slug)
  }, [linked.data])

  const daily = useGetStatsQuery({ path, params: { group_by: "day", from } })
  const orphans = useGetStatsQuery(
    { path: "/v1/stats", params: { group_by: "day", from, orphan: "true" } },
    { skip: Boolean(link_id) },
  )
  const referrers = useGetStatsQuery({ path, params: { group_by: "referer", from } })

  const [deviceView, setDeviceView] = useState<DeviceView>("platform")
  const devices = useGetStatsQuery({ path, params: { group_by: deviceView, from } })

  const totals = sumBuckets(daily.data)
  const orphanTotal = sumBuckets(orphans.data)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <LinkFilter
          value={link_id}
          name={link_name}
          onSelect={(id, name) => {
            setLinkId(id)
            setLinkName(name)
            router.replace(`/analytics/?link_id=${id}`)
          }}
          onClear={() => {
            setLinkId("")
            setLinkName("")
            router.replace("/analytics/")
          }}
        />
        <RangePicker value={range} onChange={setRange} />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <StatTile label="Total visits" value={totals.total} isLoading={daily.isLoading} />
        <StatTile
          label="Human"
          value={totals.human}
          pct={pct(totals.human, totals.total)}
          isLoading={daily.isLoading}
        />
        <StatTile
          label="Bot"
          value={totals.bot}
          pct={pct(totals.bot, totals.total)}
          isLoading={daily.isLoading}
        />
        {!link_id ? (
          <StatTile label="Orphan clicks" value={orphanTotal.total} isLoading={orphans.isLoading} />
        ) : null}
      </div>

      <VisitsChart buckets={daily.data} from={from} isLoading={daily.isLoading} />

      <div className="grid gap-3 sm:grid-cols-2">
        <BreakdownCard
          title="Referrers"
          rows={breakdownRows(referrers.data, formatReferrer, () => Link2)}
          isLoading={referrers.isLoading}
        />
        <BreakdownCard
          title="Devices"
          rows={breakdownRows(
            devices.data,
            (key) => formatDevice(deviceView, key),
            deviceIcon(deviceView),
          )}
          isLoading={devices.isLoading}
          selector={<DeviceViewSelector value={deviceView} onChange={setDeviceView} />}
        />
      </div>
    </div>
  )
}

/** `.stat-card` — a muted label, a large value, and an optional "NN%" suffix. */
function StatTile({
  label,
  value,
  pct,
  isLoading,
}: {
  label: string
  value: number
  pct?: number
  isLoading: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border bg-card p-4">
      <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tracking-tight tabular-nums">
        {isLoading ? "—" : value.toLocaleString()}
        {pct !== undefined && !isLoading ? (
          <span className="ml-1 text-[13px] font-medium text-muted-foreground">{pct}%</span>
        ) : null}
      </p>
    </div>
  )
}

/** `.chart-card` — a single-series (total visits) smoothed area chart with a per-day hover tooltip. */
function VisitsChart({
  buckets,
  from,
  isLoading,
}: {
  buckets: StatsBucket[] | undefined
  from: string | undefined
  isLoading: boolean
}) {
  const days = useMemo(() => fillDays(buckets ?? [], from).slice(-MAX_DAYS), [buckets, from])
  const chart = useMemo(() => chartPoints(days), [days])

  return (
    <div className="rounded-lg border bg-card px-5 pt-[18px] pb-3.5">
      <p className="mb-4 text-[13.5px] font-semibold">Visits over time</p>
      {isLoading ? (
        <div className="h-32 animate-pulse rounded-md bg-muted" />
      ) : !chart ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No visits recorded yet.</p>
      ) : (
        <>
          <div className="relative h-32">
            <svg
              className="absolute inset-0 size-full"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="visitsAreaGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <path d={chart.areaPath} fill="url(#visitsAreaGradient)" stroke="none" />
              <path
                d={chart.linePath}
                fill="none"
                stroke="var(--chart-1)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
            {chart.pts.map((pt) => (
              <div
                key={pt.key}
                className="group absolute inset-y-0"
                style={{ left: `${pt.hitLeft}%`, width: `${pt.hitWidth}%` }}
              >
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${pt.innerX}%`, top: `${pt.y}%` }}
                >
                  <div className="size-1.5 rounded-full bg-[var(--chart-1)] opacity-0 transition-opacity group-hover:opacity-100" />
                  <div className="absolute bottom-[calc(100%+9px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-foreground px-2.5 py-[5px] text-center text-background opacity-0 transition-opacity group-hover:opacity-100">
                    <div className="text-[11px] font-medium">{pt.dateLabel}</div>
                    <div className="text-[10.5px] opacity-75">{pt.total} visits</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{chart.firstLabel}</span>
            <span>{chart.lastLabel}</span>
          </div>
        </>
      )}
    </div>
  )
}

type BreakdownRow = { key: string; label: string; count: number; pct: number; icon: LucideIcon }

/** `.stat-list-card` — a title, an optional view selector, and a ranked row-as-meter list. */
function BreakdownCard({
  title,
  rows,
  isLoading,
  selector,
}: {
  title: string
  rows: BreakdownRow[]
  isLoading: boolean
  selector?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3.5 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">{title}</p>
        {selector}
      </div>
      {isLoading ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            <div key={i} className="h-[34px] animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No data yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.key} className="flex items-center gap-2">
              <div className="relative h-[34px] min-w-0 flex-1 overflow-hidden rounded-lg">
                <div
                  className="absolute inset-y-0 left-0 min-w-[34px] rounded-lg bg-muted"
                  style={{ width: `${row.pct}%` }}
                />
                <div className="relative z-10 flex h-full min-w-0 items-center gap-2.5 px-3">
                  <span className="flex size-[22px] shrink-0 items-center justify-center rounded-sm border bg-card">
                    <row.icon className="size-[11px] text-muted-foreground" />
                  </span>
                  <span className="truncate text-[13px]">{row.label}</span>
                </div>
              </div>
              <span className="w-8 shrink-0 text-right text-[13px] text-muted-foreground">
                {row.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The mockup's "Type / Browser / OS" text-and-chevron view switch, not a bordered button. */
function DeviceViewSelector({
  value,
  onChange,
}: {
  value: DeviceView
  onChange: (value: DeviceView) => void
}) {
  const labels: Record<DeviceView, string> = { platform: "Type", os: "OS", browser: "Browser" }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
        >
          {labels[value]}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {(Object.keys(labels) as DeviceView[]).map((key) => (
          <DropdownMenuItem key={key} onSelect={() => onChange(key)}>
            {labels[key]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function sumBuckets(data: StatsBucket[] | undefined) {
  const human = (data ?? []).reduce((sum, bucket) => sum + bucket.human, 0)
  const bot = (data ?? []).reduce((sum, bucket) => sum + bucket.bot, 0)
  return { human, bot, total: human + bot }
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 100)
}

/** Ranked dimensions are already sorted by volume server-side; this just formats and caps them. */
function breakdownRows(
  data: StatsBucket[] | undefined,
  formatLabel: (key: string) => string,
  iconFor: (key: string) => LucideIcon,
  max = 6,
): BreakdownRow[] {
  const rows = (data ?? []).slice(0, max)
  const top = rows.length > 0 ? rows[0].human + rows[0].bot : 0
  return rows.map((row) => {
    const count = row.human + row.bot
    return {
      key: row.key,
      label: formatLabel(row.key),
      count,
      pct: top === 0 ? 0 : (count / top) * 100,
      icon: iconFor(row.key),
    }
  })
}

function formatReferrer(key: string): string {
  return key === "" ? "Direct" : key
}

function formatDevice(view: DeviceView, key: string): string {
  if (view !== "platform") return key === "" ? "Unknown" : key
  if (key === "android") return "Android"
  if (key === "ios") return "iOS"
  if (key === "desktop") return "Desktop"
  return "Unknown"
}

function deviceIcon(view: DeviceView): (key: string) => LucideIcon {
  if (view !== "platform") return () => Globe
  return (key) => (key === "desktop" ? Monitor : Smartphone)
}

function formatDay(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

/** A uniform Catmull-Rom spline through `points`, as cubic Bezier segments. */
function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`

  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

/**
 * Lays `days` out on a 0–100×0–100 grid (a smoothed line + its area fill),
 * plus one invisible per-day hover column each, positioned in that column's
 * own coordinate space so a nested `group-hover` reveals just that day's dot
 * and tooltip — the mockup's adjacent-sibling `:hover` trick, without needing
 * custom CSS.
 */
function chartPoints(days: StatsBucket[]) {
  const n = days.length
  if (n === 0) return null

  const totals = days.map((bucket) => bucket.human + bucket.bot)
  const max = Math.max(...totals, 1)
  const xs = days.map((_, i) => (n === 1 ? 50 : (i / (n - 1)) * 100))
  const ys = totals.map((total) => 100 - (total / max) * 92)
  const coords = xs.map((x, i) => ({ x, y: ys[i] }))

  const boundaries = [0, ...xs.slice(0, -1).map((x, i) => (x + xs[i + 1]) / 2), 100]

  const pts = days.map((bucket, i) => {
    const hitLeft = boundaries[i]
    const hitWidth = boundaries[i + 1] - hitLeft
    return {
      key: bucket.key,
      y: ys[i],
      hitLeft,
      hitWidth,
      innerX: hitWidth === 0 ? 50 : ((xs[i] - hitLeft) / hitWidth) * 100,
      dateLabel: formatDay(bucket.key),
      total: totals[i],
    }
  })

  const linePath = smoothPath(coords)
  const areaPath = `${linePath} L ${xs[n - 1]} 100 L ${xs[0]} 100 Z`

  return {
    pts,
    linePath,
    areaPath,
    firstLabel: formatDay(days[0].key),
    lastLabel: formatDay(days[n - 1].key),
  }
}
