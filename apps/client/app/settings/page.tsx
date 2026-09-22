"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * The sidebar's Settings entry lands here, then straight on to Domains —
 * docs/plans/Plan_28.md. Domains is accessible to all roles; Keys is reached through
 * the settings sub-nav once inside, gated to admins.
 */
export default function SettingsIndexRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/settings/domains/")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
