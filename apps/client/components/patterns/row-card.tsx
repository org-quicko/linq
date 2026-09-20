"use client"

import { cn } from "cn"
import type { ReactNode } from "react"

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

/** The 40px leading icon tile every `RowCard` uses for its subject's glyph. */
export function RowCardTile({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}
