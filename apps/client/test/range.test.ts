import { describe, expect, test } from "bun:test"
import {
  analyticsEmptyMessage,
  bucketLabel,
  chartPoints,
  fillBuckets,
  periodStart,
  smoothPath,
} from "../components/analytics-overview"
import { isWindowWithinYear, presetWindow, rangeLabel, rangeValidation } from "../lib/hooks"

describe("analytics ranges", () => {
  test("describes filtered empty analytics without implying there are no visits at all", () => {
    expect(analyticsEmptyMessage(true, "No visits recorded yet.")).toBe(
      "No visits match the applied filters.",
    )
    expect(analyticsEmptyMessage(false, "No visits recorded yet.")).toBe("No visits recorded yet.")
  })

  test("preset windows include today", () => {
    expect(presetWindow("7", new Date("2026-09-22T12:00:00Z"))).toEqual({
      from: "2026-09-16",
      to: "2026-09-22",
    })
  })

  test("labels custom windows", () => {
    expect(rangeLabel("custom", { from: "2026-09-01", to: "2026-09-18" })).toContain("Sep")
  })

  test("caps custom windows at one year", () => {
    expect(isWindowWithinYear("2025-09-22", "2026-09-22")).toBe(true)
    expect(isWindowWithinYear("2025-09-20", "2026-09-22")).toBe(false)
  })

  test("requires both custom dates and orders them", () => {
    expect(rangeValidation("2026-09-01", "")).toBe("Choose both a start and end date.")
    expect(rangeValidation("", "2026-09-01")).toBe("Choose both a start and end date.")
    expect(rangeValidation("2026-09-18", "2026-09-01")).toBe(
      "Start date must be on or before end date.",
    )
    expect(rangeValidation("2026-09-01", "2026-09-18")).toBeNull()
  })

  test("period starts match the server's keys: Monday weeks, first-of-month", () => {
    expect(periodStart("2026-03-01", "day")).toBe("2026-03-01")
    expect(periodStart("2026-03-01", "week")).toBe("2026-02-23") // a Sunday
    expect(periodStart("2026-03-02", "week")).toBe("2026-03-02") // a Monday
    expect(periodStart("2026-03-31", "month")).toBe("2026-03-01")
  })

  test("zero-fills every period through `to`", () => {
    const filled = fillBuckets(
      [{ key: "2026-03-02", human: 2, bot: 0 }],
      "2026-03-01",
      "2026-03-04",
      "day",
    )
    expect(filled.map((b) => b.key)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
    ])
    expect(filled[1]).toEqual({ key: "2026-03-02", human: 2, bot: 0 })
  })

  test("folds daily buckets from a server that ignored granularity", () => {
    const days = Array.from({ length: 14 }, (_, i) => ({
      key: new Date(Date.UTC(2026, 2, i + 1)).toISOString().slice(0, 10),
      human: 1,
      bot: 0,
    }))
    const weeks = fillBuckets(days, "2026-03-01", "2026-03-14", "week")
    expect(weeks).toEqual([
      { key: "2026-02-23", human: 1, bot: 0 },
      { key: "2026-03-02", human: 7, bot: 0 },
      { key: "2026-03-09", human: 6, bot: 0 },
    ])
    expect(fillBuckets(days, "2026-03-01", "2026-03-14", "month")).toEqual([
      { key: "2026-03-01", human: 14, bot: 0 },
    ])
  })

  test("labels a bucket with the days it actually counts", () => {
    const window = { from: "2026-03-01", to: "2026-03-10" }
    // The week of Feb 23 overlaps the window by one day, Mar 1, and says so.
    expect(bucketLabel("2026-02-23", "week", window)).not.toContain("Feb")
    expect(bucketLabel("2026-02-23", "week", window)).not.toContain("–")
    expect(bucketLabel("2026-03-09", "week", window)).toContain("–")
    expect(bucketLabel("2026-03-01", "month", { from: "2026-03-01", to: "2026-03-31" })).toContain(
      "2026",
    )
  })

  test("renders the trend as a continuous line", () => {
    const chart = chartPoints([
      { key: "2026-09-01", human: 2, bot: 1 },
      { key: "2026-09-02", human: 5, bot: 0 },
    ])
    expect(chart?.linePath).toStartWith("M ")
  })

  test("keeps zero-visit days visible in a 90-day trend", () => {
    const days = Array.from({ length: 90 }, (_, index) => ({
      key: new Date(Date.UTC(2026, 5, index + 1)).toISOString().slice(0, 10),
      human: index % 9 === 0 ? 4 : 0,
      bot: 0,
    }))
    const chart = chartPoints(days)
    const zeroVisitPoints = chart?.points.filter((point) => point.total === 0) ?? []

    expect(chart?.points).toHaveLength(90)
    expect(zeroVisitPoints.every((point) => point.y === 99)).toBe(true)
  })

  test("keeps consecutive zero-visit days flat at the baseline", () => {
    const path = smoothPath([
      { x: 0, y: 4 },
      { x: 25, y: 99 },
      { x: 50, y: 99 },
      { x: 75, y: 4 },
    ])

    expect(path).toContain("C 37.5 99, 37.5 99, 50 99")
  })
})
