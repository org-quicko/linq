"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Moved to /settings/domains/. Kept as a redirect, not deleted, so an old
 * bookmark or link does not silently 404; a static export has no
 * server-side rewrite to lean on instead.
 */
export default function DomainsRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/settings/domains/")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
