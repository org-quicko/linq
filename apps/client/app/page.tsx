"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { ServerManager } from "@/components/server-manager"
import { activeServer, migrateLegacyKey } from "../lib/servers"

/**
 * The servers this browser knows, and the only page that works without a
 * connection.
 *
 * Once a server is active this is just a gate: it bounces straight to
 * `/links/`. Deliberately adding or managing servers happens at
 * `/servers/add/` and `/servers/manage/` instead, which render the same
 * `ServerManager` without the redirect.
 */
export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  )
}

function Landing() {
  const router = useRouter()
  const params = useSearchParams()
  const unauthorized = params.get("reason") === "unauthorized"
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // A browser from before the server list had one key and one server.
    migrateLegacyKey()
    if (activeServer() && !unauthorized) {
      router.replace("/links/")
      return
    }
    setReady(true)
  }, [router, unauthorized])

  if (!ready) return null

  return <ServerManager unauthorized={unauthorized} />
}
