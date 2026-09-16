"use client"

import { ArrowLeft, Check, Plus } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { ConfirmButton } from "@/components/common"
import { ServerForm } from "@/components/server-form"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  activeServer,
  addServer,
  listServers,
  migrateLegacyKey,
  removeServer,
  type Server,
  setActiveServer,
  updateServer,
} from "../lib/servers"

/**
 * The servers this browser knows, and the only page that works without a
 * connection.
 *
 * It is both the front door and the place servers are managed, because those
 * are the same screen: what you do here with nothing connected — add a server,
 * pick one — is what you come back for later to edit or forget one. Splitting
 * that across two pages would mean maintaining the same list twice.
 *
 * linq has no passwords: a user never signs in, it acts through a key an admin
 * minted. So connecting is naming a server, saying where it is, and pasting a
 * key — checked against that server before it is stored, which turns a typo
 * into an error here rather than a broken page later.
 */
export default function LandingPage() {
  return (
    <Suspense>
      <Servers />
    </Suspense>
  )
}

function Servers() {
  const router = useRouter()
  const params = useSearchParams()
  // Arriving from the switcher means "show me the list", so the shortcut
  // straight into a connected server has to be skipped.
  const managing = params.get("manage") === "1" || params.get("add") === "1"

  const [servers, setServers] = useState<Server[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(params.get("add") === "1")
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    // A browser from before the server list had one key and one server.
    migrateLegacyKey()
    const active = activeServer()
    if (active && !managing) {
      router.replace("/overview/")
      return
    }
    setServers(listServers())
    setActiveId(active?.id ?? null)
  }, [router, managing])

  // Nothing is decided until storage has been read, and a flash of the wrong
  // screen is worse than a blank moment.
  if (servers === null) return null

  function refresh() {
    setServers(listServers())
    setActiveId(activeServer()?.id ?? null)
  }

  function connect(id: string) {
    setActiveServer(id)
    // A hard load, so no page keeps data fetched from the previous server.
    window.location.href = "/overview/"
  }

  const showForm = adding || servers.length === 0

  return (
    <div className="flex min-h-screen items-start justify-center p-6 sm:items-center">
      <Card className="w-full max-w-lg">
        <CardContent>
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="font-heading text-lg font-semibold">linq</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {showForm && servers.length === 0
                  ? "Add a server to manage. Its details stay in this browser."
                  : "The servers this browser can manage. Keys are stored here only."}
              </p>
            </div>

            {activeId ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.href = "/overview/"
                }}
              >
                <ArrowLeft size={14} />
                Back
              </Button>
            ) : null}
          </div>

          <div className="mt-5 flex flex-col gap-2">
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
                      {server.apiUrl}
                    </span>
                  </span>

                  {server.id === activeId ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => connect(server.id)}
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
                      removeServer(server.id)
                      refresh()
                    }}
                  >
                    Forget
                  </ConfirmButton>
                </div>
              ),
            )}

            {showForm ? (
              <div className={servers.length > 0 ? "rounded-md border p-3" : undefined}>
                <ServerForm
                  submitLabel={servers.length === 0 ? "Connect" : "Add"}
                  onSaved={(values) => {
                    addServer(values)
                    // addServer connects to what it added.
                    window.location.href = "/overview/"
                  }}
                  onCancel={servers.length > 0 ? () => setAdding(false) : undefined}
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="mt-2 self-start"
                onClick={() => setAdding(true)}
              >
                <Plus size={16} />
                Add a server
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
