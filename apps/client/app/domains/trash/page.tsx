"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Moved to /archives/ (its Domains tab) — plans/Plan_27.md Part C2. Kept as
 * a redirect, not deleted, so an old bookmark or link does not silently
 * 404; a static export has no server-side rewrite to lean on instead.
 */
export default function DomainsTrashRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/archives/?tab=domains")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
