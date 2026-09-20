"use client"

import { Check, ChevronsUpDown, Plus, Settings2 } from "lucide-react"
import { useEffect, useState } from "react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { appUrl } from "../lib/base-path"
import { activeServer, listServers, type Server, setActiveServer } from "../lib/servers"

/**
 * The servers this browser knows, at the foot of the sidebar.
 *
 * Switching navigates with `window.location` rather than the router, which
 * remounts the whole app against the new server. Every page holds data fetched
 * from the old one, and `useApi` only refetches when its path changes — a soft
 * navigation would leave one server's links on screen under another's name.
 *
 * ponytail: a full reload is the cheap way to get that isolation. If two tabs
 * ever need different servers at once, put the id in the URL (`?server=<id>`),
 * the same trick `/links/detail/` uses, since a static export cannot route on
 * an id invented at runtime.
 */
export function ServerSwitcher() {
  const [servers, setServers] = useState<Server[]>([])
  const [current, setCurrent] = useState<Server | null>(null)

  // Storage is a browser-only thing, so this waits for the client.
  useEffect(() => {
    setServers(listServers())
    setCurrent(activeServer())
  }, [])

  function switchTo(id: string) {
    if (id === current?.id) return
    setActiveServer(id)
    window.location.href = appUrl("/analytics/")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-11 w-full items-center gap-2 rounded-lg border px-2.5 text-left transition-colors hover:bg-sidebar-border"
          title="Switch server"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {current?.name ?? "No server"}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{current?.apiUrl}</span>
          </span>
          <ChevronsUpDown size={14} className="shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuLabel>Servers</DropdownMenuLabel>
        {servers.map((server) => (
          <DropdownMenuItem key={server.id} onSelect={() => switchTo(server.id)}>
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            {server.id === current?.id ? <Check size={14} /> : null}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => (window.location.href = appUrl("/?add=1"))}>
          <Plus size={14} />
          Add a server
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => (window.location.href = appUrl("/?manage=1"))}>
          <Settings2 size={14} />
          Manage servers
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
