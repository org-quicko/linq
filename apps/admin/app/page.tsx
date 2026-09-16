"use client"

import { Plus, Server as ServerIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { ServerForm } from "@/components/server-form"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  activeServer,
  addServer,
  listServers,
  migrateLegacyKey,
  type Server,
  setActiveServer,
} from "../lib/servers"

/**
 * The landing page, and the only one that works without a connection.
 *
 * linq has no passwords: a user never signs in, it acts through a key an admin
 * minted. So connecting is naming a server, saying where it is, and pasting a
 * key — checked against that server before it is stored, which turns a typo
 * into an error here rather than a broken page later.
 */
export default function LandingPage() {
  const router = useRouter()
  const [servers, setServers] = useState<Server[] | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    // A browser from before the server list had one key and one server.
    migrateLegacyKey()
    if (activeServer()) {
      router.replace("/overview/")
      return
    }
    setServers(listServers())
  }, [router])

  // Nothing is decided until storage has been read, and a flash of the wrong
  // screen is worse than a blank moment.
  if (servers === null) return null

  function connect(id: string) {
    setActiveServer(id)
    router.replace("/overview/")
  }

  const showForm = adding || servers.length === 0

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardContent>
          <h1 className="font-heading text-lg font-semibold">linq</h1>
          <p className="mt-1 mb-5 text-sm text-muted-foreground">
            {showForm
              ? "Add a server to manage. Its details stay in this browser."
              : "Pick a server to manage."}
          </p>

          {showForm ? (
            <ServerForm
              onSaved={(values) => {
                addServer(values)
                router.replace("/overview/")
              }}
              onCancel={servers.length > 0 ? () => setAdding(false) : undefined}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {servers.map((server) => (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => connect(server.id)}
                  className="flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted"
                >
                  <ServerIcon size={16} className="shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{server.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {server.apiUrl || "This server"}
                    </span>
                  </span>
                </button>
              ))}

              <Button
                type="button"
                variant="outline"
                onClick={() => setAdding(true)}
                className="mt-2"
              >
                <Plus size={16} />
                Add a server
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
