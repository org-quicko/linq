"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { errorMessage } from "./api"

/**
 * Trails `value` by `delay`, so a filter box does not turn every keystroke into
 * a request.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}

/** How far back to read. Analytics always sends a bounded whole-day window. */
export const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const
export type Range = (typeof RANGES)[number]["value"]

type DayWindow = { from: string; to: string }

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function presetWindow(range: Range, today = new Date()): DayWindow {
  const end = utcDay(today)
  const start = new Date(`${end}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - (Number(range) - 1))
  return { from: utcDay(start), to: end }
}

export function rangeLabel(preset: Range | "custom", custom: DayWindow | null): string {
  if (preset !== "custom")
    return RANGES.find((range) => range.value === preset)?.label ?? "Last 7 days"
  if (!custom) return "Custom range"
  const format = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `${format(custom.from)} – ${format(custom.to)}`
}

export function isWindowWithinYear(from: string, to: string): boolean {
  return Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) <= 366 * 86_400_000
}

/** The custom picker explains every incomplete or invalid range before it can
 * reach the analytics API. */
export function rangeValidation(from: string, to: string): string | null {
  if (Boolean(from) !== Boolean(to)) return "Choose both a start and end date."
  if (!from || !to) return null
  if (from > to) return "Start date must be on or before end date."
  if (!isWindowWithinYear(from, to)) return "Pick a range of one year or less."
  return null
}

/**
 * A range picker's state, plus the two spellings of its start the API takes: a
 * whole UTC day for the reports, and that day's first instant for the raw log.
 *
 * Both are memoised on `range` alone and neither carries a clock reading, so a
 * re-render never produces a new value. RTK Query caches by serialised args,
 * and a fresh `Date.now()` every render is an endless refetch loop that never
 * lets `isFetching` settle back to false.
 *
 * "Last 7 days" counts today as one of them, which is what a day-grained
 * report means by it.
 */
export function useRange(initial: Range = "7") {
  const [preset, setPreset] = useState<Range | "custom">(initial)
  const [custom, setCustom] = useState<DayWindow | null>(null)
  // The clock is deliberately read inside this memo. A fresh date in an RTK
  // Query arg on every render becomes an endless refetch loop.
  const window = useMemo(
    () => (preset === "custom" ? (custom ?? presetWindow(initial)) : presetWindow(preset)),
    [preset, custom, initial],
  )
  return { preset, custom, setPreset, setCustom, ...window, label: rangeLabel(preset, custom) }
}

/** The literal six call sites spelled out by hand before `useRun` collapsed them. */
const DEFAULT_FALLBACK = "That did not work."

type RunOptions<T> = {
  /** Shown via `toast.success` on success. A function reads the result (e.g.
   *  "Reassigned 3 links."); a plain string ignores it. Omit to stay silent —
   *  several callers already show success through a UI change instead. */
  success?: string | ((result: T) => string)
  /** The message `errorMessage` falls back to when the thrown value carries
   *  none of its own. Omit for the shared default. */
  fallback?: string
  /** Runs after a successful call, with the result — closing a dialog,
   *  navigating, or storing a value the render needs (a minted secret). */
  onSuccess?: (result: T) => void
  /** Overrides the default `toast.error`, for the one caller (the server
   *  connection form) that shows its error inline instead of as a toast. */
  onError?: (message: string) => void
}

/**
 * Runs a write, owns its `saving` flag, and reports failure the same way
 * every mutation in this app should: through `errorMessage` into a toast.
 * Named `run` after the local helper `app/domains/page.tsx` already had —
 * this is that function, made reusable, once thirteen near-identical copies
 * of the same try/catch/toast block turned up across the client.
 */
export function useRun() {
  const [saving, setSaving] = useState(false)

  const run = useCallback(async <T>(thunk: () => Promise<T>, opts: RunOptions<T> = {}) => {
    setSaving(true)
    try {
      const result = await thunk()
      const message = typeof opts.success === "function" ? opts.success(result) : opts.success
      if (message) toast.success(message)
      opts.onSuccess?.(result)
      return result
    } catch (err) {
      const message = errorMessage(err, opts.fallback ?? DEFAULT_FALLBACK)
      if (opts.onError) opts.onError(message)
      else toast.error(message)
      return undefined
    } finally {
      setSaving(false)
    }
  }, [])

  return { run, saving }
}

/**
 * A local draft seeded from a server value, with `changed` true once it
 * diverges — the "edit in place, Save appears when it differs" shape used on
 * the Domains and Keys rows. `initial` is read fresh every render (it seeds
 * `useState` only once, but `changed` compares against the live argument),
 * so a row whose canonical value moves under it — a save elsewhere, a
 * refetch — is compared against the value that is actually current, not a
 * stale snapshot from first render.
 *
 * Deliberately just the comparison: `domains/page.tsx` treats an empty draft
 * as meaningful (clears the fallback) and `settings/keys/page.tsx` rejects
 * one, so each call site still computes its own `changed` when the bare
 * inequality here is not enough.
 */
export function useDraft<T>(initial: T) {
  const [value, setValue] = useState(initial)
  return { value, setValue, changed: value !== initial, reset: () => setValue(initial) }
}
