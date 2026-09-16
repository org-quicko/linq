"use client"

import { can, type Domain } from "@linq/shared"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, DataTable, QueryState, TableSkeleton } from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { errorMessage } from "../../../lib/api"
import { useListDomainsQuery, usePurgeDomainMutation } from "../../../lib/store/domains"

const HEAD = ["Host", "Fallback URL", ""]

/**
 * Archived domains, admin only. Restoring happens on the main list; this page
 * is only for the one-way trip: purging drops the domain and its clicks for
 * good, so it lives apart from the everyday archive/restore toggle.
 */
export default function DomainsTrashPage() {
  return <AppShell requires={can.purge}>{() => <DomainsTrash />}</AppShell>
}

function DomainsTrash() {
  const domains = useListDomainsQuery({ limit: 200 })
  const rows = (domains.data?.data ?? []).filter((domain) => domain.status === "archived")
  const [purgeDomain] = usePurgeDomainMutation()

  async function purge(domain: Domain) {
    try {
      await purgeDomain(domain.id).unwrap()
    } catch (err) {
      toast.error(errorMessage(err, "That did not work."))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Domains trash</h1>
        <p className="text-sm text-muted-foreground">
          Archived domains. Purging is permanent; it refuses while any link, archived included,
          still points at the host.
        </p>
      </div>

      <Card>
        <CardContent>
          <QueryState
            isLoading={domains.isLoading}
            isFetching={domains.isFetching}
            error={domains.error}
            empty={rows.length === 0}
            emptyMessage="Nothing archived."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {rows.length > 0 ? (
            <DataTable head={HEAD}>
              {rows.map((domain) => (
                <TableRow key={domain.id}>
                  <TableCell className="max-w-xs truncate font-medium">{domain.host}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {domain.fallbackUrl ?? "404 when blank"}
                  </TableCell>
                  <TableCell>
                    <ConfirmButton
                      title={`Purge ${domain.host}?`}
                      description="This destroys the domain and every click ever recorded on it. It cannot be undone. The server refuses this while any link still points at the host, archived ones included."
                      confirmLabel="Purge for good"
                      confirmText={domain.host}
                      size="sm"
                      onConfirm={() => purge(domain)}
                    >
                      Purge
                    </ConfirmButton>
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
