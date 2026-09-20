"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Moved to /analytics/ (its Orphans tab) — plans/Plan_27.md Part C1. Kept as
 * a redirect, not deleted, so an old bookmark or link does not silently
 * 404; a static export has no server-side rewrite to lean on instead.
 */
export default function OrphansRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/analytics/?tab=orphans")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
