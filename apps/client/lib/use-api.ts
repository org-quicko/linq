"use client"

import { useEffect, useState } from "react"

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
