import { describe, expect, test } from "bun:test"
import { foldWeeks } from "../components/analytics-overview"
import { isWindowWithinYear, presetWindow, rangeLabel } from "../lib/hooks"

describe("analytics ranges", () => {
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
})
