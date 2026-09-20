"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * The sidebar's Settings entry lands here, then straight on to Keys —
 * plans/Plan_27.md Part C3. Domains is reached through the settings sub-nav
 * once inside, not from the sidebar directly.
 */
export default function SettingsIndexRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/settings/keys/")
  }, [router])
  return <p className="p-8 text-sm text-muted-foreground">Redirecting…</p>
}
