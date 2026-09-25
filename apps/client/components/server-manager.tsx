"use client"

import { Link2, Plus, Trash2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { ConfirmButton } from "@/components/common"
import { RowCard, RowCardTile, Wordmark } from "@/components/patterns"
import { AddServerDialog } from "@/components/server-form"
import { Button } from "@/components/ui/button"
import { appUrl } from "../lib/base-path"
import {
  activeServer,
  addServer,
  listServers,
  probeServer,
  removeServer,
  type Server,
  setActiveServer,
} from "../lib/servers"

/**
 * The servers this browser knows: switch to, add, or remove one.
 *
 * Shared by the landing page (`/`, before anything is connected) and the
 * deliberate `/servers/add/` and `/servers/manage/` routes (reached from the
 * sidebar once a server is already active). A plain page outside the app
 * shell: its own top bar with the wordmark, and one outlined 480px card.
 * Adding happens in a dialog over this page.
 */
export function ServerManager({
  initialAdding = false,
  unauthorized = false,
}: {
  initialAdding?: boolean
  unauthorized?: boolean
}) {
  const [servers, setServers] = useState<Server[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(initialAdding)
  const [switching, setSwitching] = useState<string | null>(null)
  const [errorForServer, setErrorForServer] = useState<{ id: string; message: string } | null>(null)

  useEffect(() => {
    setServers(listServers())
    setActiveId(activeServer()?.id ?? null)
  }, [])

  if (servers === null) return null

  function refresh() {
    setServers(listServers())
    setActiveId(activeServer()?.id ?? null)
  }

  async function switchTo(server: Server) {
    if (server.id === activeId && !unauthorized) {
      window.location.href = appUrl("/links/")
      return
    }
    if (switching) return
    setSwitching(server.id)
    setErrorForServer(null)
    const result = await probeServer(server.apiUrl, server.apiKey)
    setSwitching(null)
    if (!result.ok) {
      setErrorForServer({ id: server.id, message: result.message })
      return
    }
    setActiveServer(server.id)
    window.location.href = appUrl("/links/")
  }

  const hasServers = servers.length > 0
  // A rejected key means the active server is the one that just failed, so
  // there is nothing to go back to.
  const canGoBack = activeId !== null && !unauthorized

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="flex shrink-0 items-center justify-between border-b px-7 py-3.5">
        <Wordmark />
        {canGoBack ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Back"
            className="size-10 text-muted-foreground"
            onClick={() => {
              window.location.href = appUrl("/links/")
            }}
          >
            <X className="size-[15px]" />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-1 items-center justify-center p-5">
        <div className="w-full max-w-[480px] overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-col items-center px-7 pt-7 pb-5 text-center">
            <h1 className="mb-1 text-[17px] font-semibold tracking-[-0.01em]">Servers</h1>
            <p className="text-[13px] text-muted-foreground">
              {hasServers
                ? "Switch between servers, or add another."
                : "Add the Linq server your workspace runs on to get started."}
            </p>
            {unauthorized ? (
              <p className="mt-3 w-full rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                That API key was rejected by the server. It may have expired or been revoked.
              </p>
            ) : null}
          </div>

          <div className="px-7 pt-5 pb-6">
            {hasServers ? (
              <>
                <div className="no-scrollbar flex max-h-[320px] flex-col gap-2.5 overflow-y-auto">
                  {servers.map((server) => (
                    <div key={server.id} className="flex flex-col gap-1">
                      <RowCard
                        onClick={() => switchTo(server)}
                        tile={
                          <RowCardTile>
                            <Link2 className="size-4" />
                          </RowCardTile>
                        }
                        actions={
                          <>
                            {server.id !== activeId ? (
                              <Button
                                type="button"
                                variant="outline"
                                className="h-8 px-2.5 text-[12.5px]"
                                disabled={switching === server.id}
                                onClick={() => switchTo(server)}
                              >
                                {switching === server.id ? "Switching…" : "Switch"}
                              </Button>
                            ) : null}
                            <ConfirmButton
                              variant="destructive"
                              className="size-10 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground dark:bg-transparent"
                              title="Remove server?"
                              description={`You'll be disconnected from "${server.name}" and it will be removed from your list of servers.`}
                              confirmLabel="Remove server"
                              onConfirm={() => {
                                removeServer(server.id)
                                refresh()
                              }}
                            >
                              <Trash2 className="size-4" />
                              <span className="sr-only">Remove server</span>
                            </ConfirmButton>
                          </>
                        }
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-semibold">{server.name}</span>
                          {server.id === activeId ? (
                            <span className="inline-flex h-5 shrink-0 items-center rounded-sm border bg-background px-2 text-[11px] font-medium text-muted-foreground">
                              Active
                            </span>
                          ) : null}
                        </div>
                        <span className="truncate text-[12.5px] text-muted-foreground">
                          {server.apiUrl}
                        </span>
                      </RowCard>
                      {errorForServer?.id === server.id ? (
                        <p className="px-1 text-xs text-destructive">{errorForServer.message}</p>
                      ) : null}
                    </div>
                  ))}
                </div>

                <Button
                  type="button"
                  variant="outline"
                  className="mt-4 h-11 w-full gap-[7px] text-[13.5px]"
                  onClick={() => setAdding(true)}
                >
                  <Plus className="size-3.5" />
                  Add server
                </Button>
              </>
            ) : (
              <Button
                type="button"
                className="h-11 w-full gap-[7px] text-[13.5px] hover:bg-primary/90"
                onClick={() => setAdding(true)}
              >
                <Plus className="size-3.5" />
                Add server
              </Button>
            )}
          </div>
        </div>
      </div>

      <AddServerDialog
        open={adding}
        onOpenChange={setAdding}
        onSaved={(values) => {
          addServer(values)
          // A first server goes straight into the app; another one keeps you
          // here, so switching stays a deliberate choice.
          if (!hasServers) {
            window.location.href = appUrl("/links/")
            return
          }
          setAdding(false)
          setErrorForServer(null)
          refresh()
        }}
      />
    </div>
  )
}
