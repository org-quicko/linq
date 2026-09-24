"use client"

import type { ReactNode } from "react"

/**
 * The h1 + optional description + right-aligned actions block every page
 * opened with by hand. Nine pages had it character-for-character identical
 * (`font-heading text-xl font-semibold`, `text-sm text-muted-foreground`);
 * two had drifted — Settings → Keys to a smaller weight, the landing page to
 * a smaller size.
 *
 * `title` takes a `ReactNode`, not just a string: the link detail page's
 * heading carries a `CopyButton` and status badges inline, and that shape
 * needs to keep working rather than being special-cased back to a bare h1.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div>
        <h1 className="flex items-center gap-2 font-heading text-xl font-semibold">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
