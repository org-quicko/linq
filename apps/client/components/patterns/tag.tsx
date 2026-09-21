import { cn } from "cn"
import type { ComponentProps } from "react"
import { Badge } from "@/components/ui/badge"

/**
 * The design's outlined, square-ish tag chip — `Badge variant="outline"` is
 * close but not it: `rounded-4xl` sits in `badge.tsx`'s base class ahead of
 * any variant, so the pill shape can't be reached with a variant alone.
 */
export function Tag({ className, ...props }: ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-sm bg-background text-[11px] text-muted-foreground", className)}
      {...props}
    />
  )
}
