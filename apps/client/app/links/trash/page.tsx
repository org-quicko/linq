"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Moved to /archives/ (its Links tab) — docs/plans/Plan_27.md Part C2. Kept as a
 * redirect, not deleted, so an old bookmark or link does not silently 404; a
 * static export has no server-side rewrite to lean on instead.
 */
export default function LinksTrashRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/archives/?tab=links")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
