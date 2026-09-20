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

/** How far back to read. "0" sends no `from` at all, i.e. the whole history. */
export const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "0", label: "All time" },
] as const
export type Range = (typeof RANGES)[number]["value"]

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
  const [range, setRange] = useState<Range>(initial)
  const from = useMemo(() => {
    if (range === "0") return undefined
    const day = new Date()
    day.setUTCDate(day.getUTCDate() - (Number(range) - 1))
    return day.toISOString().slice(0, 10)
  }, [range])
  return { range, setRange, from, fromInstant: from && `${from}T00:00:00.000Z` }
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
