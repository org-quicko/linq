"use client"

import { NOT_RECORDED, type StatsBucket } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { Check, ChevronDown, Globe, Monitor, Smartphone, X } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { type ReactNode, useEffect, useId, useMemo, useState } from "react"
import { RangePicker } from "@/components/common"
import { LinkFilter } from "@/components/patterns"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useRange } from "@/lib/hooks"
import { useGetLinkQuery } from "../lib/store/links"
import {
  useGetAnalyticsBreakdownQuery,
  useGetAnalyticsSummaryQuery,
  useGetAnalyticsTimeseriesQuery,
} from "../lib/store/stats"

type DeviceView = "platform" | "os" | "browser"
type Segment = { dim: DeviceView | "referer"; value: string }
const FILTERS: Segment["dim"][] = ["referer", "os", "browser", "platform"]

export function AnalyticsOverview() {
  const router = useRouter()
  const search = useSearchParams()
  const [link_id, setLinkId] = useState(() => search.get("link_id") ?? "")
  const [segments, setSegments] = useState<Segment[]>(() =>
    FILTERS.flatMap((dim) =>
      (search.get(dim) ?? "")
        .split(",")
        .filter(Boolean)
        .map((value) => ({ dim, value })),
    ),
  )
  const [deviceView, setDeviceView] = useState<DeviceView>("platform")
  const linked = useGetLinkQuery(link_id || skipToken)
  const { preset, custom, setPreset, setCustom, from, to, label } = useRange()
  const params = useMemo(() => {
    const grouped = Object.fromEntries(
      FILTERS.map((dim) => [
        dim,
        segments
          .filter((s) => s.dim === dim)
          .map((s) => s.value)
          .join(","),
      ]),
    )
    return { from, to, link_id: link_id || undefined, ...grouped }
  }, [from, to, link_id, segments])
  useEffect(() => {
    const query = new URLSearchParams()
    if (link_id) query.set("link_id", link_id)
    for (const [key, value] of Object.entries(params))
      if (key !== "from" && key !== "to" && value) query.set(key, value)
    router.replace(`/analytics/${query.size ? `?${query}` : ""}`)
  }, [link_id, params, router])

  const summary = useGetAnalyticsSummaryQuery(params)
  const timeseries = useGetAnalyticsTimeseriesQuery(params)
  const referrers = useGetAnalyticsBreakdownQuery({ ...params, dimension: "referer" })
  const devices = useGetAnalyticsBreakdownQuery({ ...params, dimension: deviceView })
  const toggle = (dim: Segment["dim"], raw: string) => {
    const value = raw || NOT_RECORDED
    setSegments((current) =>
      current.some((s) => s.dim === dim && s.value === value)
        ? current.filter((s) => s.dim !== dim || s.value !== value)
        : [...current, { dim, value }],
    )
  }
  const remove = (segment: Segment) =>
    setSegments((current) => current.filter((item) => item !== segment))
  const selected = (dim: Segment["dim"]) => segments.filter((segment) => segment.dim === dim)
  const totals = summary.data ?? { visits: 0, human: 0, bot: 0, orphans: 0 }
  const hasAppliedFilters = Boolean(link_id || segments.length || preset !== "7")

  return (
    <div className="analytics-page-enter flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="shrink-0 font-heading text-xl font-semibold">Analytics</h1>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {segments.map((segment) => (
            <button
              key={`${segment.dim}:${segment.value}`}
              type="button"
              className="flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-xs"
              onClick={() => remove(segment)}
            >
              {segmentLabel(segment)}
              <X className="size-3" />
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <LinkFilter
            value={link_id}
            name={linked.data?.name ?? linked.data?.slug ?? ""}
            onSelect={(id) => setLinkId(id)}
            onClear={() => setLinkId("")}
          />
          <RangePicker
            preset={preset}
            custom={custom}
            label={label}
            onPreset={setPreset}
            onCustom={(window) => {
              setCustom(window)
              setPreset("custom")
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <StatTile label="Total visits" value={totals.visits} loading={summary.isLoading} />
        <StatTile
          label="Human"
          value={totals.human}
          pct={pct(totals.human, totals.visits)}
          loading={summary.isLoading}
        />
        <StatTile
          label="Bot"
          value={totals.bot}
          pct={pct(totals.bot, totals.visits)}
          loading={summary.isLoading}
        />
        {!link_id ? (
          <StatTile label="Orphan clicks" value={totals.orphans} loading={summary.isLoading} />
        ) : null}
      </div>
      <VisitsChart
        buckets={timeseries.data ?? []}
        from={from}
        loading={timeseries.isLoading}
        hasAppliedFilters={hasAppliedFilters}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <BreakdownCard
          title="Referrers"
          dimension="referer"
          rows={referrers.data ?? []}
          loading={referrers.isLoading}
          active={selected("referer")}
          hasAppliedFilters={hasAppliedFilters}
          onClick={toggle}
        />
        <BreakdownCard
          title="Devices"
          dimension={deviceView}
          rows={devices.currentData ?? []}
          loading={devices.isFetching && !devices.currentData}
          active={selected(deviceView)}
          hasAppliedFilters={hasAppliedFilters}
          onClick={toggle}
          selector={<DeviceViewSelector value={deviceView} onChange={setDeviceView} />}
        />
      </div>
    </div>
  )
}

function StatTile({
  label,
  value,
  pct: percentage,
  loading,
}: {
  label: string
  value: number
  pct?: number
  loading: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg border bg-card p-4">
      <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">
        {loading ? "—" : value.toLocaleString()}
        {percentage !== undefined && !loading ? (
          <span className="ml-1 text-[13px] text-muted-foreground">{percentage}%</span>
        ) : null}
      </p>
    </div>
  )
}

function BreakdownCard({
  title,
  dimension,
  rows,
  loading,
  active,
  hasAppliedFilters,
  onClick,
  selector,
}: {
  title: string
  dimension: Segment["dim"]
  rows: StatsBucket[]
  loading: boolean
  active: Segment[]
  hasAppliedFilters: boolean
  onClick: (dim: Segment["dim"], key: string) => void
  selector?: ReactNode
}) {
  const shown = active.length
    ? rows.filter((row) => active.some((segment) => segment.value === (row.key || NOT_RECORDED)))
    : rows.slice(0, 6)
  const max = shown[0] ? shown[0].human + shown[0].bot : 1
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold">{title}</p>
        {selector}
      </div>
      {loading ? (
        <div className="h-28 animate-pulse rounded bg-muted" />
      ) : shown.length ? (
        <div className="space-y-1.5">
          {shown.map((row) => {
            const count = row.human + row.bot
            return (
              <button
                key={row.key}
                type="button"
                className="group flex w-full cursor-pointer items-center gap-2"
                onClick={() => onClick(dimension, row.key)}
              >
                <span className="relative flex h-8 min-w-0 flex-1 overflow-hidden rounded text-left">
                  <span
                    className="analytics-chart-reveal absolute inset-y-0 left-0 bg-muted group-hover:bg-border"
                    style={{ width: `${(count / max) * 100}%` }}
                  />
                  <span className="relative flex min-w-0 items-center gap-2 px-2">
                    <BreakdownIcon dimension={dimension} value={row.key} />
                    <span className="truncate text-sm">{formatValue(dimension, row.key)}</span>
                  </span>
                </span>
                <span className="w-10 text-right text-sm tabular-nums text-muted-foreground">
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {analyticsEmptyMessage(hasAppliedFilters, "No data yet.")}
        </p>
      )}
    </div>
  )
}

function BreakdownIcon({ dimension, value }: { dimension: Segment["dim"]; value: string }) {
  const Icon = dimension !== "platform" ? Globe : value === "desktop" ? Monitor : Smartphone
  return <Icon className="size-3 shrink-0 text-muted-foreground" />
}
function formatValue(dim: Segment["dim"], value: string) {
  if (!value) return dim === "referer" ? "Direct" : "(not recorded)"
  if (dim === "platform") return value === "ios" ? "iOS" : value[0].toUpperCase() + value.slice(1)
  return value
}
function segmentLabel(segment: Segment) {
  const labels = { referer: "Referrer", os: "OS", browser: "Browser", platform: "Device" }
  return `${labels[segment.dim]}: ${formatValue(segment.dim, segment.value === NOT_RECORDED ? "" : segment.value)}`
}
function pct(part: number, total: number) {
  return total ? Math.round((part / total) * 100) : 0
}

export function analyticsEmptyMessage(hasAppliedFilters: boolean, fallback: string): string {
  return hasAppliedFilters ? "No visits match the applied filters." : fallback
}

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
          className="flex cursor-pointer items-center gap-1 text-[13px] text-muted-foreground"
        >
          {labels[value]}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
        {(Object.keys(labels) as DeviceView[]).map((key) => (
          <DropdownMenuItem key={key} onSelect={() => onChange(key)}>
            {labels[key]}
            {key === value ? <Check className="ml-auto size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function fillDays(buckets: StatsBucket[], from: string): StatsBucket[] {
  if (!buckets.length) return buckets
  const found = new Map(buckets.map((bucket) => [bucket.key, bucket]))
  const end = buckets[buckets.length - 1].key
  const result: StatsBucket[] = []
  for (
    let day = new Date(`${from}T00:00:00Z`);
    utc(day) <= end;
    day.setUTCDate(day.getUTCDate() + 1)
  )
    result.push(found.get(utc(day)) ?? { key: utc(day), human: 0, bot: 0 })
  return result
}
export function foldWeeks(days: StatsBucket[]): StatsBucket[] {
  if (days.length <= 120) return days
  const weeks = new Map<string, StatsBucket>()
  for (const day of days) {
    const date = new Date(`${day.key}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const key = utc(date)
    const current = weeks.get(key) ?? { key, human: 0, bot: 0 }
    current.human += day.human
    current.bot += day.bot
    weeks.set(key, current)
  }
  return [...weeks.values()]
}
function utc(date: Date) {
  return date.toISOString().slice(0, 10)
}

export function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ""
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`
  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]
    const p2 = points[i + 1]
    const midX = (p1.x + p2.x) / 2
    path += ` C ${midX} ${p1.y}, ${midX} ${p2.y}, ${p2.x} ${p2.y}`
  }
  return path
}

/** The line/area chart's geometry and per-point hover columns. */
export function chartPoints(days: StatsBucket[]) {
  if (!days.length) return null
  const totals = days.map((day) => day.human + day.bot)
  const max = Math.max(...totals, 1)
  // A stroke centered at y=100 is clipped by the viewBox. 99 puts zero-count
  // buckets on the visual baseline while retaining the full stroke.
  const plotTop = 4
  const plotBottom = 99
  const xs = days.map((_, index) => (days.length === 1 ? 50 : (index / (days.length - 1)) * 100))
  const ys = totals.map((total) => plotBottom - (total / max) * (plotBottom - plotTop))
  const boundaries = [0, ...xs.slice(0, -1).map((x, index) => (x + xs[index + 1]) / 2), 100]
  const linePath = smoothPath(xs.map((x, index) => ({ x, y: ys[index] })))
  const areaPath = `${linePath} L ${xs[xs.length - 1]} ${plotBottom} L ${xs[0]} ${plotBottom} Z`
  return {
    linePath,
    areaPath,
    points: days.map((day, index) => ({
      ...day,
      total: totals[index],
      x: xs[index],
      y: ys[index],
      left: boundaries[index],
      width: boundaries[index + 1] - boundaries[index],
    })),
  }
}

function formatDay(day: string) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

function VisitsChart({
  buckets,
  from,
  loading,
  hasAppliedFilters,
}: {
  buckets: StatsBucket[]
  from: string
  loading: boolean
  hasAppliedFilters: boolean
}) {
  const days = useMemo(() => foldWeeks(fillDays(buckets, from)), [buckets, from])
  const chart = useMemo(() => chartPoints(days), [days])
  const gradientId = useId()
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-4 text-sm font-semibold">Visits over time</p>
      {loading ? (
        <div className="h-32 animate-pulse rounded bg-muted" />
      ) : !chart ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {analyticsEmptyMessage(hasAppliedFilters, "No visits recorded yet.")}
        </p>
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
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
                </linearGradient>
                <clipPath id={`${gradientId}-reveal`}>
                  <rect className="analytics-chart-reveal" x="0" y="0" width="100" height="100" />
                </clipPath>
              </defs>
              <g clipPath={`url(#${gradientId}-reveal)`}>
                <path d={chart.areaPath} fill={`url(#${gradientId})`} stroke="none" />
                <path
                  d={chart.linePath}
                  fill="none"
                  stroke="var(--chart-1)"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              </g>
            </svg>
            {chart.points.map((point) => (
              <div
                key={point.key}
                className="group absolute inset-y-0"
                style={{ left: `${point.left}%`, width: `${point.width}%` }}
              >
                <div
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${((point.x - point.left) / point.width) * 100}%`,
                    top: `${point.y}%`,
                  }}
                >
                  <div className="size-1.5 rounded-full bg-[var(--chart-1)] opacity-0 group-hover:opacity-100" />
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-foreground px-2 py-1 text-center text-[11px] text-background opacity-0 group-hover:opacity-100">
                    <div>
                      {days.length > 120 ? `week of ${formatDay(point.key)}` : formatDay(point.key)}
                    </div>
                    <div className="opacity-75">{point.total} visits</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{formatDay(days[0].key)}</span>
            <span>{formatDay(days[days.length - 1].key)}</span>
          </div>
        </>
      )}
    </div>
  )
}
