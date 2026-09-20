"use client"

import { can, type Domain } from "@linq/shared"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton } from "@/components/common"
import { Collection, PageHeader } from "@/components/patterns"
import { Card, CardContent } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { useRun } from "../../../lib/hooks"
import { useListDomainsQuery, usePurgeDomainMutation } from "../../../lib/store/domains"

const HEAD = ["Host", "Fallback URL", ""]

/**
 * Archived domains, admin only. Restoring happens on the main list; this page
 * is only for the one-way trip: purging drops the domain and its visits for
 * good, so it lives apart from the everyday archive/restore toggle.
 */
export default function DomainsTrashPage() {
  return <AppShell requires={can.purge}>{() => <DomainsTrash />}</AppShell>
}

function DomainsTrash() {
  const domains = useListDomainsQuery({ limit: 200 })
  const rows = (domains.data?.data ?? []).filter((domain) => domain.status === "archived")
  const [purgeDomain] = usePurgeDomainMutation()
  const { run } = useRun()

  function purge(domain: Domain) {
    return run(() => purgeDomain(domain.id).unwrap())
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Domains trash"
        description="Archived domains. Purging is permanent; it refuses while any link, archived included, still points at the host."
      />

      <Card>
        <CardContent>
          <Collection query={domains} rows={rows} head={HEAD} emptyMessage="Nothing archived.">
            {(domain) => (
              <TableRow key={domain.id}>
                <TableCell className="max-w-xs truncate font-medium">{domain.host}</TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  {domain.fallbackUrl ?? "404 when blank"}
                </TableCell>
                <TableCell>
                  <ConfirmButton
                    title={`Purge ${domain.host}?`}
                    description="This destroys the domain and every visit ever recorded on it. It cannot be undone. The server refuses this while any link still points at the host, archived ones included."
                    confirmLabel="Purge for good"
                    confirmText={domain.host}
                    size="sm"
                    onConfirm={() => purge(domain)}
                  >
                    Purge
                  </ConfirmButton>
                </TableCell>
              </TableRow>
            )}
          </Collection>
        </CardContent>
      </Card>
    </div>
  )
}
