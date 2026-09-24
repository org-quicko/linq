"use client"

import { CardSkeleton } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"

/**
 * A single metric tile: a muted label and a large `tabular-nums` value.
 * `tabular-nums` matters here specifically — without it, digits have
 * different widths, so a value refreshing in place visibly jitters.
 *
 * `isLoading` renders `CardSkeleton` (@/components/common), which shares
 * this same `Card`/`CardContent` wrapper — see that file's comment for why
 * that box-model match is the point, not a coincidence.
 */
export function StatCard({
  label,
  value,
  isLoading,
}: {
  label: string
  value: number | undefined
  isLoading: boolean
}) {
  if (isLoading) return <CardSkeleton />
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1 font-heading text-2xl font-semibold tabular-nums">
          {value === undefined ? "—" : value}
        </p>
      </CardContent>
    </Card>
  )
}
