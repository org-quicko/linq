"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect } from "react"

/**
 * Backward compatibility: redirects legacy /links/detail/?id=... to /links/{id}/summary.
 * See plans/Plan_30.md.
 */
export default function LinkDetailPage() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-muted-foreground">Redirecting…</p>}>
      <LinkDetailRedirect />
    </Suspense>
  )
}

function LinkDetailRedirect() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = searchParams.get("id")

  useEffect(() => {
    if (id) {
      router.replace(`/links/${encodeURIComponent(id)}/summary/`)
    } else {
      router.replace("/links/")
    }
  }, [id, router])

  return <p className="p-8 text-sm text-muted-foreground">Redirecting to summary…</p>
}
