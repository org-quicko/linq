"use client"

import { type Actor, can, type Role } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { cn } from "cn"
import { Archive, LineChart, Link2, Settings } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { type ReactNode, useEffect } from "react"
import { QueryState } from "@/components/common"
import { PageHeader, ThemeToggle } from "@/components/patterns"
import { ServerSwitcher } from "@/components/server-switcher"
import { Button } from "@/components/ui/button"
import { activeServer } from "../lib/servers"
import { type Me, useGetMeQuery } from "../lib/store/keys"
import { useCountLinksQuery } from "../lib/store/links"

/**
 * The sidebar's entries. Flat — no grouping — per the design: Settings is
 * still pinned below the spacer, but Short links / Analytics / Archives sit
 * as three plain rows above it rather than nested under group headings.
 *
 * Hrefs are basePath-free: `next/link` and `router` prepend the configured base path
 * themselves, and `usePathname` strips it back off, so writing it here would
 * both double it in the URL and stop the active-link comparison below from
 * ever matching. `lib/api.ts` is the one place that spells it out, because it
 * navigates with `window.location`, which Next does not touch.
 *
 * Settings links straight to its first real page. The `/settings/` index is
 * retained only for old bookmarks; routing normal navigation through its
 * client-side redirect can leave the user waiting on that intermediate page.
 */
type NavItem = {
  href: string
  label: string
  icon: typeof Link2
  visible: (actor: Actor) => boolean
}

const NAV: NavItem[] = [
  { href: "/links/", label: "Short links", icon: Link2, visible: () => true },
  { href: "/analytics/", label: "Analytics", icon: LineChart, visible: () => true },
  { href: "/archives/", label: "Archives", icon: Archive, visible: can.purge },
]

/**
 * Pinned to the foot of the sidebar, below the spacer. Visible to every role
 * now that Domains lives inside Settings (Part C3) — the settings sub-nav
 * (`SettingsNav`) is what filters Keys down to admins, the same way the
 * standalone Domains page did before the move.
 */
const SETTINGS: NavItem = {
  href: "/settings/domains/",
  label: "Settings",
  icon: Settings,
  visible: () => true,
}

/** Every href the sidebar can light up. */
const ALL_HREFS = [...NAV, SETTINGS].map((item) => item.href)

/**
 * The href lit as active for a given path.
 *
 * Nesting means `/links/` is a prefix of `/links/detail/` as well as its own
 * subpages, so a plain "starts with" per link would light up more than one
 * entry at once. The longest matching href is the most specific one, and
 * therefore the right one.
 */
function activeHref(pathname: string): string | undefined {
  if (pathname.startsWith("/settings/")) return SETTINGS.href

  return ALL_HREFS.filter((href) => pathname.startsWith(href)).sort(
    (a, b) => b.length - a.length,
  )[0]
}

/**
 * Wraps every connected page: sends a visitor with no server back to the
 * landing page, loads `/me` once, and hands the acting user down so a page can
 * gate its own controls.
 *
 * `requires` gates the whole page. Hiding a nav link is not a gate — the pages
 * behind them are reachable by typing the URL — so a page whose whole purpose
 * needs a role says so here.
 *
 * All of this is cosmetic. Every call is checked again on the server, against
 * the same `can.*` predicates; hiding a button is a courtesy, not a permission.
 */
export function AppShell({
  requires,
  children,
}: {
  requires?: (actor: Actor) => boolean
  children: (actor: Actor) => ReactNode
}) {
  const router = useRouter()
  const { data: me, error, isLoading } = useGetMeQuery()

  useEffect(() => {
    if (!activeServer()) router.replace("/")
  }, [router])

  // A server the user typed the address of is one that can be unreachable, so
  // this is an ordinary state, not an edge case. It keeps the chrome: without
  // the switcher on screen there is no way to leave a server that never answers.
  if (isLoading || error || !me) {
    return (
      <Chrome>
        <div className="no-scrollbar h-full overflow-y-auto px-7 py-6">
          <QueryState
            isLoading={isLoading}
            error={error ?? (me ? null : { message: "Could not load your account." })}
          />
        </div>
      </Chrome>
    )
  }

  const actor: Actor = { keyId: me.id, role: me.role }

  return (
    <Chrome actor={actor} me={me}>
      {requires && !requires(actor) ? (
        <div className="no-scrollbar h-full overflow-y-auto px-7 py-6">
          <NotPermitted role={me.role} />
        </div>
      ) : (
        children(actor)
      )}
    </Chrome>
  )
}

/**
 * The sidebar and the floating content panel beside it. Rendered with or
 * without an actor, since an unreachable server still has to be navigable
 * away from.
 *
 * The backdrop (--muted) and the panel (--card, --shadow-panel,
 * --radius-xl) are what makes the content read as an island rather than a
 * page.
 */
function Chrome({ actor, me, children }: { actor?: Actor; me?: Me; children: ReactNode }) {
  const active = activeHref(usePathname())

  // Both share `listLinks`'s "LIST" tag, so any create/archive/purge
  // anywhere in the app refetches these too — the sidebar counts stay live
  // without a bespoke invalidation of their own.
  const activeLinks = useCountLinksQuery(actor ? {} : skipToken)
  const archivedLinks = useCountLinksQuery(
    actor && can.purge(actor) ? { status: "archived" } : skipToken,
  )
  const counts: Partial<Record<string, number>> = {
    "/links/": activeLinks.data?.total,
    "/archives/": archivedLinks.data?.total,
  }

  return (
    <div className="flex h-screen overflow-hidden bg-muted">
      <aside className="flex w-60 shrink-0 flex-col gap-2 p-4">
        <Link
          href="/links/"
          className="flex items-center gap-[7px] px-[9px] pb-3 pt-2 font-heading text-[15px] font-semibold tracking-[-0.02em]"
        >
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-primary">
            <Link2 className="size-[13px] text-primary-foreground" />
          </span>
          Linq
        </Link>

        <ServerSwitcher />

        <nav className="mt-2.5 flex flex-col gap-0.5">
          {NAV.map((item) =>
            !actor || item.visible(actor) ? (
              <NavLink
                key={item.href}
                item={item}
                active={active === item.href}
                count={counts[item.href]}
              />
            ) : null,
          )}
        </nav>

        <div className="flex-grow" />

        {!actor || SETTINGS.visible(actor) ? (
          <NavLink item={SETTINGS} active={active === SETTINGS.href} />
        ) : null}

        {me ? (
          <div className="mt-1 flex flex-col gap-2 border-t pt-2">
            <div className="flex items-center gap-2 px-2.5 py-1">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-xs font-medium"
                aria-hidden
              >
                {me.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {me.name} · {me.role}
              </span>
            </div>
            <div className="flex items-center justify-between px-2.5">
              <span className="text-xs text-muted-foreground">Theme</span>
              <ThemeToggle />
            </div>
          </div>
        ) : null}
      </aside>

      <main className="flex h-screen flex-1 flex-col p-4 pl-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-panel">
          <div className="mx-auto flex min-h-0 w-full max-w-[1080px] flex-1 flex-col">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}

function NavLink({
  item,
  active,
  count,
}: {
  item: NavItem
  active: boolean
  /** Omitted, not zero, hides the badge — an empty list gets no "0" clutter,
   *  matching the mockup's own `hasActiveLinks`/`hasArchivedLinks` gate. */
  count?: number
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      className={cn(
        "flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors",
        active
          ? "bg-sidebar-border font-semibold"
          : "text-muted-foreground hover:bg-sidebar-border hover:text-foreground",
      )}
    >
      <Icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} />
      {item.label}
      {count ? <span className="ml-auto text-[11px] text-muted-foreground">{count}</span> : null}
    </Link>
  )
}

/** What a page shows instead of its contents when the role is not enough. */
function NotPermitted({ role }: { role: Role }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Not available to you" />
      <div className="rounded-lg border p-6">
        <p className="text-sm text-muted-foreground">
          This page needs a more privileged role than <strong>{role}</strong>. Ask an admin if you
          need it.
        </p>
        <Link href="/links/" className="mt-4 inline-block">
          <Button type="button" variant="outline">
            Back to links
          </Button>
        </Link>
      </div>
    </div>
  )
}

export type { Me }
