"use client"

import { Link2, Pencil, Plus, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { ConfirmButton } from "@/components/common"
import { IconButton, RowCard, RowCardTile } from "@/components/patterns"
import { ServerForm } from "@/components/server-form"
import { Badge } from "@/components/ui/badge"
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
  updateServer,
} from "../lib/servers"

/**
 * The servers this browser knows: connect, add, edit, or remove one.
 *
 * Shared by the landing page (`/`, before anything is connected) and the
 * deliberate `/servers/add/` and `/servers/manage/` routes (reached from the
 * sidebar once a server is already active). Restyled to the mockup's
 * plain-page treatment: a bordered 480px card on --background, its own top
 * bar with the wordmark, and no app shell.
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
  const [editing, setEditing] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
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

  async function connect(server: Server) {
    if (server.id === activeId) {
      window.location.href = appUrl("/links/")
      return
    }
    setConnecting(server.id)
    setErrorForServer(null)
    const result = await probeServer(server.apiUrl, server.apiKey)
    setConnecting(null)
    if (!result.ok) {
      setErrorForServer({ id: server.id, message: result.message })
      return
    }
    setActiveServer(server.id)
    window.location.href = appUrl("/links/")
  }

  const showForm = adding || servers.length === 0

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top bar with wordmark */}
      <div className="flex h-14 items-center border-b px-6">
        <div className="flex items-center gap-2">
          <div className="flex size-[22px] shrink-0 items-center justify-center rounded-[6px] bg-primary text-primary-foreground">
            <Link2 className="size-3.5" />
          </div>
          <span className="font-heading text-[15px] font-semibold tracking-tight">Linq</span>
        </div>
      </div>

      {/* Centered card */}
      <div className="flex flex-1 items-center justify-center p-4 sm:p-6">
        <div className="w-full max-w-[480px] overflow-hidden rounded-[--radius-xl] border bg-card shadow-panel">
          <div className="flex flex-col items-center px-7 pt-7 pb-4 text-center">
            <h1 className="font-heading text-[17px] font-semibold tracking-tight">Servers</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {showForm && servers.length === 0
                ? "Add the Linq server your workspace runs on to get started."
                : "Switch between servers, or add another."}
            </p>
            {unauthorized ? (
              <p className="mt-3 w-full rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                That API key was rejected by the server. It may have expired or been revoked.
              </p>
            ) : null}
          </div>

          <div className="px-7 pb-7 pt-2">
            {editing ? (
              (() => {
                const server = servers.find((s) => s.id === editing)
                if (!server) return null
                return (
                  <div className="rounded-lg border p-4">
                    <ServerForm
                      server={server}
                      submitLabel="Save"
                      onSaved={(values) => {
                        updateServer(server.id, values)
                        setEditing(null)
                        setErrorForServer(null)
                        refresh()
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )
              })()
            ) : showForm ? (
              <div className={servers.length > 0 ? "rounded-lg border p-4" : undefined}>
                <ServerForm
                  submitLabel={servers.length === 0 ? "Connect" : "Add"}
                  onSaved={(values) => {
                    addServer(values)
                    window.location.href = appUrl("/links/")
                  }}
                  onCancel={servers.length > 0 ? () => setAdding(false) : undefined}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="no-scrollbar flex max-h-[320px] flex-col gap-2.5 overflow-y-auto">
                  {servers.map((server) => (
                    <div key={server.id} className="flex flex-col gap-1">
                      <RowCard
                        onClick={() => connect(server)}
                        tile={
                          <RowCardTile>
                            <Link2 className="size-4" />
                          </RowCardTile>
                        }
                        actions={
                          <div className="flex items-center gap-1.5">
                            {server.id !== activeId ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-8 px-2.5 text-xs"
                                disabled={connecting === server.id}
                                onClick={() => connect(server)}
                              >
                                {connecting === server.id ? "Connecting…" : "Connect"}
                              </Button>
                            ) : null}
                            <IconButton
                              icon={Pencil}
                              label="Edit server"
                              onClick={() => setEditing(server.id)}
                            />
                            <ConfirmButton
                              className="size-10"
                              ariaLabel="Forget server"
                              title={`Forget ${server.name}?`}
                              description="This removes the server from this browser. Nothing on the server itself is changed, and re-entering its URL and key brings it back."
                              confirmLabel="Forget"
                              onConfirm={() => {
                                removeServer(server.id)
                                refresh()
                              }}
                            >
                              <Trash2 className="size-4" />
                            </ConfirmButton>
                          </div>
                        }
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-semibold">{server.name}</span>
                          {server.id === activeId ? (
                            <Badge variant="outline" className="text-[11px] font-normal">
                              Active
                            </Badge>
                          ) : null}
                        </div>
                        <span className="truncate text-xs text-muted-foreground">
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
                  className="h-11 w-full justify-center"
                  onClick={() => setAdding(true)}
                >
                  <Plus className="size-4" />
                  Add server
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
