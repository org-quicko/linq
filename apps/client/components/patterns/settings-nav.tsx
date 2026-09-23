"use client"

import type { Actor } from "@linq/shared"
import { can } from "@linq/shared"
import { cn } from "cn"
import { Globe, KeyRound } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"

type SettingsItem = {
  href: string
  label: string
  icon: typeof Globe
  visible: (actor: Actor) => boolean
}

const ITEMS: SettingsItem[] = [
  { href: "/settings/domains/", label: "Domains", icon: Globe, visible: () => true },
  { href: "/settings/keys/", label: "Keys", icon: KeyRound, visible: can.manageKeys },
]

/**
 * The mockup's 172px settings sub-nav — the one place this design uses a left
 * nav instead of tabs, since Settings is the section expected to grow.
 * Unlike the sidebar's flat list, this one must
 * filter per item rather than show everything and gate on click: Domains is
 * readable by every role, Keys only by an admin, and a viewer must never see
 * a Keys entry that renders `NotPermitted`.
 */
export function SettingsNav({ actor, children }: { actor: Actor; children: ReactNode }) {
  const pathname = usePathname()

  return (
    <div className="flex gap-6">
      <nav className="flex w-[172px] shrink-0 flex-col gap-0.5">
        {ITEMS.filter((item) => item.visible(actor)).map((item) => {
          const Icon = item.icon
          const active = pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </Link>
          )
        })}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
