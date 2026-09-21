"use client"

import { cn } from "cn"
import type { CSSProperties, ReactNode } from "react"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The design's `.link-row` — replaces `DataTable` on Links, Archives,
 * Settings → Domains, Settings → Keys and the Servers list. A leading tile
 * slot (`RowCardTile`), a min-width-0 title/subtitle column for `children`,
 * and a trailing actions slot. The single highest-leverage piece of the
 * restyle: five surfaces, one definition.
 */
export function RowCard({
  tile,
  actions,
  className,
  onClick,
  children,
}: {
  tile?: ReactNode
  actions?: ReactNode
  className?: string
  onClick?: (e: React.MouseEvent) => void
  children: ReactNode
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: card contains keyboard-navigable child links
    // biome-ignore lint/a11y/noStaticElementInteractions: card area click navigation
    <div
      onClick={onClick}
      className={cn(
        "flex items-center gap-4 rounded-lg border bg-card px-5 py-3.5 transition-colors hover:bg-muted",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {tile}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
      {actions ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: inner actions stop propagation
        // biome-ignore lint/a11y/noStaticElementInteractions: container for action buttons/menus
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </div>
  )
}

/** The 40px leading icon tile every `RowCard` uses for its subject's glyph.
 *  `style` is the one escape hatch — the QR list swatches a row's own
 *  colours, which can't be a Tailwind class since they're arbitrary hex from
 *  user data. */
export function RowCardTile({
  children,
  className,
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div
      style={style}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

/**
 * `RowCard`'s loading twin — same box model (40px tile, two text lines, a
 * trailing action slot), so a list doesn't jump when its real rows replace
 * this. `Collection` (@/components/patterns) renders a stack of these for
 * every `variant="list"` page instead of `QueryState`'s plain "Loading…"
 * text, the same way `TableSkeleton` already stood in for a `variant="table"`
 * page.
 */
export function RowCardSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-lg border bg-card px-5 py-3.5">
      <Skeleton className="size-10 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Skeleton className="size-10 rounded-lg" />
        <Skeleton className="size-10 rounded-lg" />
      </div>
    </div>
  )
}
