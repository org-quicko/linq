"use client"

import { type Actor, can, type Role } from "@linq/shared"
import { cn } from "cn"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { type ReactNode, useEffect } from "react"
import { QueryState } from "@/components/common"
import { ServerSwitcher } from "@/components/server-switcher"
import { Button } from "@/components/ui/button"
import { activeServer, disconnect } from "../lib/servers"
import { useApi } from "../lib/use-api"

type Me = { user: { id: string; name: string; role: Role }; keyPrefix: string | null }

/**
 * Nav entries, each with the predicate that decides whether it is offered.
 *
 * Hrefs are basePath-free: `next/link` and `router` prepend `/admin` themselves,
 * and `usePathname` strips it back off, so writing it here would both double it
 * in the URL and stop the active-link comparison below from ever matching.
 * `lib/api.ts` is the one place that spells it out, because it navigates with
 * `window.location`, which Next does not touch.
 */
type NavItem = {
  href: string
  label: string
  visible: (actor: Actor) => boolean
}

type NavGroup = { label: string; children: NavItem[] }

/** What you look at. */
const NAV: (NavItem | NavGroup)[] = [
  { href: "/overview/", label: "Overview", visible: () => true },
  {
    label: "Links",
    children: [
      { href: "/links/", label: "Short links", visible: () => true },
      { href: "/orphans/", label: "Orphans", visible: () => true },
    ],
  },
]

/**
 * What you configure on the connected server. Pinned to the foot of the sidebar,
 * below the divider.
 *
 * Servers themselves are not here: the list of them is browser-local, not part
 * of any server's configuration, and it lives on the landing page the switcher
 * below goes to.
 */
const SETTINGS: NavGroup = {
  label: "Settings",
  children: [
    { href: "/settings/domains/", label: "Domains", visible: () => true },
    { href: "/settings/users/", label: "Users", visible: can.manageUsers },
  ],
}

const isGroup = (item: NavItem | NavGroup): item is NavGroup => "children" in item

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
  const { data: me, error, loading } = useApi<Me>("/v1/me")

  useEffect(() => {
    if (!activeServer()) router.replace("/")
  }, [router])

  // A server the user typed the address of is one that can be unreachable, so
  // this is an ordinary state, not an edge case. It keeps the chrome: without
  // the switcher on screen there is no way to leave a server that never answers.
  if (loading || error || !me) {
    return (
      <Chrome>
        <QueryState
          loading={loading}
          error={error ?? (me ? null : "Could not load your account.")}
        />
      </Chrome>
    )
  }

  const actor: Actor = { userId: me.user.id, role: me.user.role }

  return (
    <Chrome actor={actor} me={me}>
      {requires && !requires(actor) ? <NotPermitted role={me.user.role} /> : children(actor)}
    </Chrome>
  )
}

/**
 * The sidebar and the page beside it. Rendered with or without an actor, since
 * an unreachable server still has to be navigable away from.
 */
function Chrome({ actor, me, children }: { actor?: Actor; me?: Me; children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
        <div className="px-4 py-4">
          <Link href="/overview/" className="font-heading text-base font-semibold">
            linq
          </Link>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2">
          {NAV.map((item) =>
            isGroup(item) ? (
              <NavGroup key={item.label} group={item} actor={actor} pathname={pathname} />
            ) : !actor || item.visible(actor) ? (
              <NavLink key={item.href} item={item} pathname={pathname} />
            ) : null,
          )}
        </nav>

        <div className="flex flex-col gap-2 border-t p-2">
          <NavGroup group={SETTINGS} actor={actor} pathname={pathname} />

          {me ? (
            <div className="flex items-center gap-2 px-2.5 py-1">
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium"
                aria-hidden
              >
                {me.user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {me.user.name} · {me.user.role}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  disconnect()
                  router.replace("/")
                }}
                title="Disconnect from this server"
              >
                Leave
              </Button>
            </div>
          ) : null}

          <ServerSwitcher />
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-6 py-6">{children}</main>
    </div>
  )
}

/**
 * A heading and the entries under it. The heading is not a link: it names the
 * group, and every destination is one of its children.
 *
 * Children are filtered before the heading renders, so a group whose entries a
 * role may not see disappears rather than leaving a label with nothing beneath it.
 */
function NavGroup({
  group,
  actor,
  pathname,
}: {
  group: NavGroup
  actor?: Actor
  pathname: string
}) {
  const visible = group.children.filter((child) => !actor || child.visible(actor))
  if (visible.length === 0) return null

  return (
    <div className="mt-2">
      <span className="px-2.5 text-xs font-medium text-muted-foreground">{group.label}</span>
      <div className="mt-0.5 flex flex-col gap-0.5">
        {visible.map((child) => (
          <NavLink key={child.href} item={child} pathname={pathname} nested />
        ))}
      </div>
    </div>
  )
}

function NavLink({
  item,
  pathname,
  nested,
}: {
  item: NavItem
  pathname: string
  nested?: boolean
}) {
  // Prefix, not equality: "Short links" stays lit on /links/new/ and
  // /links/detail/. No nav href is a prefix of another, so nothing double-lights.
  const active = pathname.startsWith(item.href)

  return (
    <Link
      href={item.href}
      className={cn(
        "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
        nested && "pl-5",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {item.label}
    </Link>
  )
}

/** What a page shows instead of its contents when the role is not enough. */
function NotPermitted({ role }: { role: Role }) {
  return (
    <div className="rounded-lg border p-6">
      <h1 className="font-heading text-base font-medium">Not available to you</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This page needs a more privileged role than <strong>{role}</strong>. Ask an admin if you
        need it.
      </p>
      <Link href="/links/" className="mt-4 inline-block">
        <Button type="button" variant="outline">
          Back to links
        </Button>
      </Link>
    </div>
  )
}

export type { Me }
