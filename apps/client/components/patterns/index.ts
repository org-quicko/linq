/**
 * Composed, app-aware building blocks — `components/ui` knows nothing about
 * linq, everything here knows about domains, links and roles. One barrel so
 * a call site writes `from "@/components/patterns"` once, not a `.../row-card`
 * per import.
 *
 * Grows with the restyle in plans/Plan_27.md: `RowCard`, `IconButton`,
 * `EmptyState`, `StatCard` and `TabShell` land alongside the pages that
 * first need them (Part B's shell, Part C's routes) rather than speculatively
 * ahead of any call site.
 */
export { Collection } from "./collection"
export { DomainPicker } from "./domain-picker"
export { PageHeader } from "./page-header"
export { ShortLink, shortLinkText } from "./short-link"
export { ThemeToggle } from "./theme-toggle"
