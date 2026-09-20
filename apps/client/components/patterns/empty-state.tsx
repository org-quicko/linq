/**
 * The centred, muted "nothing here" line — the design's version of what
 * `QueryState` (@/components/common) already rendered inline for its empty
 * state. `QueryState` renders this internally, so no call site has to
 * change to get it; this is exported for the rare place that needs the
 * block on its own.
 */
export function EmptyState({ message }: { message: string }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{message}</p>
}
