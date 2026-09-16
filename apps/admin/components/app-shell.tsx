"use client"

import { type Actor, can, type Role } from "@linq/shared"
import { cn } from "cn"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { type ReactNode, useEffect } from "react"
import { QueryState } from "@/components/common"
import { Button } from "@/components/ui/button"
import { clearKey, getKey } from "../lib/api"
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
const NAV: { href: string; label: string; visible: (actor: Actor) => boolean }[] = [
  { href: "/links/", label: "Links", visible: () => true },
  { href: "/domains/", label: "Domains", visible: () => true },
  { href: "/orphans/", label: "Orphans", visible: () => true },
  { href: "/users/", label: "Users", visible: can.manageUsers },
]

/**
 * Wraps every signed-in page: sends a visitor with no key back to login, loads
 * `/me` once, and hands the acting user down so a page can gate its own controls.
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
  const pathname = usePathname()
  const { data: me, error, loading } = useApi<Me>("/v1/me")

  useEffect(() => {
    if (!getKey()) router.replace("/")
  }, [router])

  if (loading || error || !me) {
    return (
      <div className="p-8">
        <QueryState
          loading={loading}
          error={error ?? (me ? null : "Could not load your account.")}
        />
      </div>
    )
  }

  const actor: Actor = { userId: me.user.id, role: me.user.role }

  return (
    <div className="min-h-screen">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/links/" className="font-heading text-base font-semibold">
            linq
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.filter((item) => item.visible(actor)).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors",
                  pathname.startsWith(item.href)
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <span>
              {me.user.name} · {me.user.role}
            </span>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                clearKey()
                router.replace("/")
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {requires && !requires(actor) ? <NotPermitted role={me.user.role} /> : children(actor)}
      </main>
    </div>
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
