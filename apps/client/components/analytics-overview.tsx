"use client"

import { NOT_RECORDED, type StatsBucket } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { ChevronDown, Globe, Monitor, Smartphone, X } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { type ReactNode, useEffect, useMemo, useState } from "react"
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
        <div className="flex flex-wrap gap-2">
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
      <VisitsChart buckets={timeseries.data ?? []} from={from} loading={timeseries.isLoading} />
      <div className="grid gap-3 sm:grid-cols-2">
        <BreakdownCard
          title="Referrers"
          dimension="referer"
          rows={referrers.data ?? []}
          loading={referrers.isLoading}
          active={selected("referer")}
          onClick={toggle}
        />
        <BreakdownCard
          title="Devices"
          dimension={deviceView}
          rows={devices.data ?? []}
          loading={devices.isLoading}
          active={selected(deviceView)}
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
  onClick,
  selector,
}: {
  title: string
  dimension: Segment["dim"]
  rows: StatsBucket[]
  loading: boolean
  active: Segment[]
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
                className="flex w-full cursor-pointer items-center gap-2"
                onClick={() => onClick(dimension, row.key)}
              >
                <span className="relative flex h-8 min-w-0 flex-1 overflow-hidden rounded bg-muted text-left">
                  <span
                    className="absolute inset-y-0 left-0 bg-primary/15"
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
        <p className="py-4 text-center text-sm text-muted-foreground">No data yet.</p>
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
function VisitsChart({
  buckets,
  from,
  loading,
}: {
  buckets: StatsBucket[]
  from: string
  loading: boolean
}) {
  const days = useMemo(() => foldWeeks(fillDays(buckets, from)), [buckets, from])
  const max = Math.max(...days.map((day) => day.human + day.bot), 1)
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="mb-4 text-sm font-semibold">Visits over time</p>
      {loading ? (
        <div className="h-32 animate-pulse rounded bg-muted" />
      ) : !days.length ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No visits recorded yet.</p>
      ) : (
        <>
          <div className="flex h-32 items-end gap-px">
            {days.map((day) => (
              <div
                key={day.key}
                className="group relative h-full flex-1"
                title={`${day.key}: ${day.human + day.bot} visits`}
              >
                <div
                  className="absolute right-0 bottom-0 left-0 rounded-t bg-primary/35 group-hover:bg-primary"
                  style={{ height: `${((day.human + day.bot) / max) * 100}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{days[0].key}</span>
            <span>{days[days.length - 1].key}</span>
          </div>
        </>
      )}
    </div>
  )
}
