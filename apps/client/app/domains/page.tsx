"use client"

import { type Actor, can, type Domain } from "@linq/shared"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, DataTable, Field, QueryState, TableSkeleton } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { useRun } from "../../lib/hooks"
import {
  useArchiveDomainMutation,
  useCreateDomainMutation,
  useListDomainsQuery,
  useUpdateDomainMutation,
} from "../../lib/store/domains"

const HEAD = ["Host", "Fallback URL", "Links", "", ""]

/**
 * Domains and their fallback URLs.
 *
 * Everyone may read this page; only an admin sees the write controls. Archiving
 * is refused by the server while any link still points at the domain, archived
 * included, and that refusal is surfaced here rather than pre-empted, so the
 * rule lives in one place.
 */
export default function DomainsPage() {
  return <AppShell>{(actor) => <DomainsList actor={actor} />}</AppShell>
}

function DomainsList({ actor }: { actor: Actor }) {
  const domains = useListDomainsQuery({ limit: 200 })
  const [createDomain] = useCreateDomainMutation()
  const [updateDomain] = useUpdateDomainMutation()
  const [archiveDomain] = useArchiveDomainMutation()
  const isAdmin = can.manageDomains(actor)
  const rows = domains.data?.data ?? []
  const { run } = useRun()

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-heading text-xl font-semibold">Domains</h1>

      {isAdmin ? (
        <NewDomainCard onCreate={(body) => run(() => createDomain(body).unwrap())} />
      ) : null}

      <Card>
        <CardContent>
          <QueryState
            isLoading={domains.isLoading}
            isFetching={domains.isFetching}
            error={domains.error}
            empty={rows.length === 0}
            emptyMessage="No domains yet."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {rows.length > 0 ? (
            <DataTable head={HEAD}>
              {rows.map((domain) => (
                <DomainRow
                  key={domain.id}
                  domain={domain}
                  isAdmin={isAdmin}
                  onSaveFallback={(fallbackUrl) =>
                    run(() => updateDomain({ id: domain.id, body: { fallbackUrl } }).unwrap())
                  }
                  onToggleStatus={() =>
                    run(() =>
                      domain.status === "active"
                        ? archiveDomain(domain.id).unwrap()
                        : updateDomain({ id: domain.id, body: { status: "active" } }).unwrap(),
                    )
                  }
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
  onSaveFallback,
  onToggleStatus,
}: {
  domain: Domain
  isAdmin: boolean
  onSaveFallback: (fallbackUrl: string | null) => void
  onToggleStatus: () => void
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
      <TableCell className="tabular-nums">{domain.linkCount}</TableCell>
      <TableCell>
        {domain.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
      </TableCell>
      <TableCell>
        {isAdmin ? (
          domain.status === "active" ? (
            <ConfirmButton
              title={`Archive ${domain.host}?`}
              description="Every short URL on this host stops resolving, including its fallback. The server refuses this while any link, archived included, still points at this host. Purge them first."
              confirmLabel="Archive"
              onConfirm={onToggleStatus}
            >
              Archive
            </ConfirmButton>
          ) : (
            <Button type="button" variant="outline" onClick={onToggleStatus}>
              Restore
            </Button>
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
