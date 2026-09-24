import { describe, expect, test } from "bun:test"
import {
  analyticsEmptyMessage,
  chartPoints,
  foldWeeks,
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

  test("folds dense days into Monday weeks", () => {
    const days = Array.from({ length: 121 }, (_, i) => ({
      key: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
      human: 1,
      bot: 0,
    }))
    const weeks = foldWeeks(days)
    expect(weeks.length).toBeLessThan(days.length)
    expect(weeks[0]).toEqual({ key: "2025-12-29", human: 4, bot: 0 })
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
