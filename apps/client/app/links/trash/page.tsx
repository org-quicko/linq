"use client"

import { can, type Link } from "@linq/shared"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton } from "@/components/common"
import { Collection, PageHeader, ShortLink, shortLinkText } from "@/components/patterns"
import { Card, CardContent } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { qs } from "../../../lib/api"
import { useRun } from "../../../lib/hooks"
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
  const { run } = useRun()

  function purge(link: Link) {
    return run(() => purgeLink(link.id).unwrap())
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Links trash"
        description="Archived links. Purging is permanent and releases the slug for reuse."
      />

      <Card>
        <CardContent>
          <Collection query={links} rows={rows} head={HEAD} emptyMessage="Nothing archived.">
            {(link) => (
              <TableRow key={link.id}>
                <TableCell className="max-w-xs">
                  <ShortLink link={link} href={`/links/detail/${qs({ id: link.id })}`} />
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  <span title={link.destination}>{link.destination}</span>
                </TableCell>
                <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                  {link.ownerName ?? "—"}
                </TableCell>
                <TableCell>
                  <ConfirmButton
                    title={`Purge ${shortLinkText(link)}?`}
                    description="This destroys the link and every visit ever recorded on it. It cannot be undone, and the slug becomes free for reuse on this domain."
                    confirmLabel="Purge for good"
                    confirmText={link.slug}
                    size="sm"
                    onConfirm={() => purge(link)}
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
