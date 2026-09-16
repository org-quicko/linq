"use client"

import { can, type Link } from "@linq/shared"
import NextLink from "next/link"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import {
  ConfirmButton,
  CopyButton,
  DataTable,
  QueryState,
  TableSkeleton,
} from "@/components/common"
import { Card, CardContent } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { errorMessage, qs } from "../../../lib/api"
import { useListLinksQuery, usePurgeLinkMutation } from "../../../lib/store/links"

const HEAD = ["Short URL", "Destination", "Owner", ""]

/**
 * Archived links, admin only. Restoring happens on the main list; this page is
 * only for the one-way trip: purging releases the slug and drops the link for
 * good, so it lives apart from the everyday archive/restore toggle.
 */
export default function LinksTrashPage() {
  return <AppShell requires={can.purge}>{() => <LinksTrash />}</AppShell>
}

function LinksTrash() {
  const links = useListLinksQuery({ status: "archived", limit: 200 })
  const rows = links.data?.data ?? []
  const [purgeLink] = usePurgeLinkMutation()

  async function purge(link: Link) {
    try {
      await purgeLink(link.id).unwrap()
    } catch (err) {
      toast.error(errorMessage(err, "That did not work."))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-heading text-xl font-semibold">Links trash</h1>
        <p className="text-sm text-muted-foreground">
          Archived links. Purging is permanent and releases the slug for reuse.
        </p>
      </div>

      <Card>
        <CardContent>
          <QueryState
            isLoading={links.isLoading}
            isFetching={links.isFetching}
            error={links.error}
            empty={rows.length === 0}
            emptyMessage="Nothing archived."
            skeleton={<TableSkeleton head={HEAD} />}
          />

          {rows.length > 0 ? (
            <DataTable head={HEAD}>
              {rows.map((link) => (
                <TableRow key={link.id}>
                  <TableCell className="max-w-xs">
                    <div className="flex items-center gap-1">
                      <NextLink
                        href={`/links/detail/${qs({ id: link.id })}`}
                        className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
                      >
                        {link.domainHost}/{link.slug}
                      </NextLink>
                      <CopyButton value={link.shortUrl} />
                    </div>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    <span title={link.destination}>{link.destination}</span>
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                    {link.ownerName}
                  </TableCell>
                  <TableCell>
                    <ConfirmButton
                      title={`Purge ${link.domainHost}/${link.slug}?`}
                      description="This destroys the link and every click ever recorded on it. It cannot be undone, and the slug becomes free for reuse on this domain."
                      confirmLabel="Purge for good"
                      confirmText={link.slug}
                      size="sm"
                      onConfirm={() => purge(link)}
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
