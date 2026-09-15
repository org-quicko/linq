"use client"

import { type Actor, can, type Domain, type Page } from "@linq/shared"
import { useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, DataTable, Field, QueryState } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { del, patch, post } from "../../lib/api"
import { useApi } from "../../lib/use-api"

/**
 * Domains and their fallback URLs.
 *
 * Everyone may read this page; only an admin sees the write controls. Archiving
 * is refused by the server while the domain still has active linqs, and that
 * refusal is surfaced here rather than pre-empted, so the rule lives in one place.
 */
export default function DomainsPage() {
  return <AppShell>{(actor) => <DomainsList actor={actor} />}</AppShell>
}

function DomainsList({ actor }: { actor: Actor }) {
  const domains = useApi<Page<Domain>>("/v1/domains?limit=200")
  const isAdmin = can.manageDomains(actor)
  const rows = domains.data?.data ?? []

  /** Runs a write, surfaces the server's message, and refreshes the list. */
  async function run(action: () => Promise<unknown>) {
    try {
      await action()
      domains.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-xl font-semibold">Domains</h1>

      {isAdmin ? <NewDomainCard onCreate={(body) => run(() => post("/v1/domains", body))} /> : null}

      <Card>
        <CardContent>
          <QueryState
            loading={domains.loading}
            error={domains.error}
            empty={rows.length === 0}
            emptyMessage="No domains yet."
          />

          {rows.length > 0 ? (
            <DataTable head={["Host", "Fallback URL", "Active linqs", "", ""]}>
              {rows.map((domain) => (
                <DomainRow
                  key={domain.id}
                  domain={domain}
                  isAdmin={isAdmin}
                  canPurge={can.purge(actor)}
                  onSaveFallback={(fallbackUrl) =>
                    run(() => patch(`/v1/domains/${domain.id}`, { fallbackUrl }))
                  }
                  onToggleStatus={() =>
                    run(() =>
                      domain.status === "active"
                        ? del(`/v1/domains/${domain.id}`)
                        : patch(`/v1/domains/${domain.id}`, { status: "active" }),
                    )
                  }
                  onPurge={() => run(() => del(`/v1/domains/${domain.id}/purge`))}
                />
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

/** One row, with the fallback URL editable in place. */
function DomainRow({
  domain,
  isAdmin,
  canPurge,
  onSaveFallback,
  onToggleStatus,
  onPurge,
}: {
  domain: Domain
  isAdmin: boolean
  canPurge: boolean
  onSaveFallback: (fallbackUrl: string | null) => void
  onToggleStatus: () => void
  onPurge: () => void
}) {
  const [fallback, setFallback] = useState(domain.fallbackUrl ?? "")
  const changed = fallback !== (domain.fallbackUrl ?? "")

  return (
    <TableRow className={domain.status === "archived" ? "opacity-60" : undefined}>
      <TableCell className="max-w-xs truncate font-medium">{domain.host}</TableCell>
      <TableCell>
        {isAdmin ? (
          <div className="flex items-center gap-2">
            <Input
              value={fallback}
              placeholder="404 when blank"
              onChange={(event) => setFallback(event.target.value)}
            />
            {changed ? (
              <Button type="button" onClick={() => onSaveFallback(fallback.trim() || null)}>
                Save
              </Button>
            ) : null}
          </div>
        ) : (
          <span className="block truncate text-muted-foreground">
            {domain.fallbackUrl ?? "404 when blank"}
          </span>
        )}
      </TableCell>
      <TableCell className="tabular-nums">{domain.linqCount}</TableCell>
      <TableCell>
        {domain.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
      </TableCell>
      <TableCell>
        {isAdmin ? (
          domain.status === "active" ? (
            <ConfirmButton
              title={`Archive ${domain.host}?`}
              description="Every short URL on this host stops resolving, including its fallback. The server refuses this while the domain still has active linqs."
              confirmLabel="Archive"
              onConfirm={onToggleStatus}
            >
              Archive
            </ConfirmButton>
          ) : (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onToggleStatus}>
                Restore
              </Button>
              {/* Purge is offered only once the domain is archived: the server
                  refuses it otherwise, and on an active row it would read as an
                  alternative to archiving rather than a step after it. */}
              {canPurge ? (
                <ConfirmButton
                  title={`Purge ${domain.host}?`}
                  description="This destroys the domain and every click ever recorded on it. It cannot be undone. The server refuses this while any linq still points at the host, archived ones included."
                  confirmLabel="Purge for good"
                  confirmText={domain.host}
                  onConfirm={onPurge}
                >
                  Purge
                </ConfirmButton>
              ) : null}
            </div>
          )
        ) : null}
      </TableCell>
    </TableRow>
  )
}

/** The add-a-domain form, shown to admins only. */
function NewDomainCard({
  onCreate,
}: {
  onCreate: (body: { host: string; fallbackUrl: string | null }) => void
}) {
  const [host, setHost] = useState("")
  const [fallbackUrl, setFallbackUrl] = useState("")

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Add a domain</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        <div className="min-w-56 flex-1">
          <Field label="Host" hint="Point its DNS at linq. Include a port only for local use.">
            <Input
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="links.example.com"
            />
          </Field>
        </div>
        <div className="min-w-56 flex-1">
          <Field label="Fallback URL" hint="Where an unknown slug goes. Blank means 404.">
            <Input
              value={fallbackUrl}
              onChange={(event) => setFallbackUrl(event.target.value)}
              placeholder="https://example.com/"
            />
          </Field>
        </div>
        <Button
          type="button"
          disabled={!host.trim()}
          onClick={() => {
            onCreate({ host: host.trim(), fallbackUrl: fallbackUrl.trim() || null })
            setHost("")
            setFallbackUrl("")
          }}
        >
          Add domain
        </Button>
      </CardContent>
    </Card>
  )
}
