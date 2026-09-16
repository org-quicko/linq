"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "./api"

export type Query<T> = {
  data: T | null
  error: string | null
  loading: boolean
  /** Re-runs the request, for use after a write. */
  reload: () => void
}

/**
 * The read half of every page: fetch on mount, refetch when `path` changes or
 * `reload` is called.
 *
 * Passing `null` skips the request entirely, which is how a page waits for an id
 * from the query string before asking for anything.
 *
 * Deliberately small: a CRUD admin does not need a caching data layer, and
 * `reload` after a write is the whole invalidation story.
 */
export function useApi<T>(path: string | null): Query<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(path !== null)
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the refetch trigger, not a value the effect reads
  useEffect(() => {
    if (path === null) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)

    api<T>(path)
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(null)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    // A page that navigates away mid-flight must not write into a dead component.
    return () => {
      cancelled = true
    }
  }, [path, attempt])

  return { data, error, loading, reload: useCallback(() => setAttempt((n) => n + 1), []) }
}

/**
 * Trails `value` by `delay`, so a filter box does not turn every keystroke into
 * a request. The typed value stays immediate; only what `useApi` watches waits.
 */
export function useDebounced<T>(value: T, delay = 300): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}
