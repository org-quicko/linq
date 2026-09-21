"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect } from "react"

/**
 * Backward compatibility: redirects legacy /links/detail/?id=... to the
 * analytics page filtered to that link. The summary view it used to point at
 * is gone (plans/Plan_31.md Part C).
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
      router.replace(`/analytics/?link_id=${encodeURIComponent(id)}`)
    } else {
      router.replace("/links/")
    }
  }, [id, router])

  return <p className="p-8 text-sm text-muted-foreground">Redirecting to analytics…</p>
}
