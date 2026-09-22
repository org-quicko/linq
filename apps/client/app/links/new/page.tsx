"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Create is now a dialog over /links/ instead of its own route — docs/plans/Plan_27.md
 * Part C4. Kept as a redirect, not deleted, so an old bookmark or link does not
 * silently 404; a static export has no server-side rewrite to lean on instead.
 */
export default function NewLinkRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/links/")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
