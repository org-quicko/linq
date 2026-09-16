"use client"

import { Check, Plus } from "lucide-react"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton } from "@/components/common"
import { ServerForm } from "@/components/server-form"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  activeServer,
  addServer,
  listServers,
  removeServer,
  type Server,
  setActiveServer,
  updateServer,
} from "../../lib/servers"

/**
 * Server management: the list this browser holds, and what can be done to it.
 *
 * Nothing here touches a server. Adding, editing and forgetting are all local
 * bookkeeping, which is why forgetting asks for a plain confirmation rather
 * than a typed one: it is undone by re-entering the URL and key.
 */
export default function SettingsPage() {
  return (
    <Suspense>
      <AppShell>{() => <Settings />}</AppShell>
    </Suspense>
  )
}

function Settings() {
  const params = useSearchParams()
  const [servers, setServers] = useState<Server[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // The switcher's "Add a server" lands here with the form already open.
  const [adding, setAdding] = useState(params.get("add") === "1")
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    setServers(listServers())
    setActiveId(activeServer()?.id ?? null)
  }, [])

  function refresh() {
    setServers(listServers())
    setActiveId(activeServer()?.id ?? null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Servers</h1>
        <p className="text-sm text-muted-foreground">
          The servers this browser can manage. Keys are stored here only.
        </p>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Servers</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {servers.map((server) =>
            editing === server.id ? (
              <div key={server.id} className="rounded-md border p-3">
                <ServerForm
                  server={server}
                  submitLabel="Save"
                  onSaved={(values) => {
                    updateServer(server.id, values)
                    setEditing(null)
                    refresh()
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <div
                key={server.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{server.name}</span>
                    {server.id === activeId ? (
                      <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <Check size={12} /> connected
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {server.apiUrl || "This server"}
                  </span>
                </span>

                {server.id === activeId ? null : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setActiveServer(server.id)
                      // A hard load so no page keeps the old server's data.
                      window.location.href = "/admin/overview/"
                    }}
                  >
                    Connect
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(server.id)}
                >
                  Edit
                </Button>

                <ConfirmButton
                  size="sm"
                  title={`Forget ${server.name}?`}
                  description="This removes the server from this browser. Nothing on the server itself is changed, and re-entering its URL and key brings it back."
                  confirmLabel="Forget"
                  onConfirm={() => {
                    const wasActive = server.id === activeId
                    removeServer(server.id)
                    if (wasActive) window.location.href = "/admin/"
                    else refresh()
                  }}
                >
                  Forget
                </ConfirmButton>
              </div>
            ),
          )}

          {adding ? (
            <div className="rounded-md border p-3">
              <ServerForm
                submitLabel="Add"
                onSaved={(values) => {
                  addServer(values)
                  // addServer connects to what it added.
                  window.location.href = "/admin/overview/"
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              onClick={() => setAdding(true)}
            >
              <Plus size={16} />
              Add a server
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
