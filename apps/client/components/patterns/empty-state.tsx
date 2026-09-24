import type { LucideIcon } from "lucide-react"

/**
 * The centred, muted "nothing here" block — the design's version of what
 * `QueryState` (@/components/common) already rendered inline for its empty
 * state. `QueryState` renders this internally, so no call site has to
 * change to get it; this is exported for the rare place that needs the
 * block on its own.
 *
 * `flex-1` lets it fill (and centre in) the rest of a flex-column page;
 * in a non-flex parent it is a no-op and the block just sits with padding.
 */
export function EmptyState({ message, icon: Icon }: { message: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center">
      {Icon ? (
        <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
