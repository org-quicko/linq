"use client"

import { can, type Link } from "@linq/shared"
import { Link2, RotateCcw, Trash2 } from "lucide-react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, When } from "@/components/common"
import {
  Collection,
  IconButton,
  PageHeader,
  RowCard,
  RowCardTile,
  ShortLink,
  shortLinkText,
} from "@/components/patterns"
import { useRun } from "../../lib/hooks"
import {
  useListLinksQuery,
  usePurgeLinkMutation,
  useUpdateLinkMutation,
} from "../../lib/store/links"

/**
 * Archived links — domains don't live here (plans/Plan_27.md Part C3 moved
 * domain archive/restore/purge onto Settings → Domains itself, which already
 * shows every domain, active or archived, with a Restore action; a second
 * copy of that flow here would just be a duplicate trash can for the same
 * rows).
 *
 * `requires={can.purge}` is unchanged from before: archived rows are kept
 * forever (docs/adr/0002) and purge is the only way to remove one, so
 * reaching this page at all is already an admin-only action.
 */
export default function ArchivesPage() {
  return <AppShell requires={can.purge}>{() => <Archives />}</AppShell>
}

function Archives() {
  return (
    <div className="no-scrollbar flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-7 py-6">
      <PageHeader title="Archives" description="Archived links. Purging is permanent." />
      <ArchivedLinksTab />
    </div>
  )
}

function ArchivedLinksTab() {
  const links = useListLinksQuery({ status: "archived", limit: 200 })
  const rows = links.data?.data ?? []
  const [updateLink] = useUpdateLinkMutation()
  const [purgeLink] = usePurgeLinkMutation()
  const { run } = useRun()

  function restore(link: Link) {
    return run(() => updateLink({ id: link.id, body: { status: "active" } }).unwrap())
  }

  function purge(link: Link) {
    return run(() => purgeLink(link.id).unwrap())
  }

  /** Purges every row on this tab, one call per link — there is no bulk-purge
   *  endpoint (a domain-scoped one is a named follow-up, not this plan's
   *  scope), so this fans out over the same mutation the row action uses. */
  function emptyArchive() {
    return run(() => Promise.all(rows.map((link) => purgeLink(link.id).unwrap())), {
      success: "Emptied the archive.",
      fallback: "Could not empty the archive.",
    })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Archived links stop appearing in your short links list but keep working until you delete
          them for good.
        </p>
        {rows.length > 0 ? (
          <ConfirmButton
            variant="outline"
            className="shrink-0 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            title="Empty the archive?"
            description="Purges every archived link for good, and every visit ever recorded on each of them. This cannot be undone."
            confirmLabel="Empty archive"
            onConfirm={emptyArchive}
          >
            <Trash2 />
            Empty archive
          </ConfirmButton>
        ) : null}
      </div>

      <Collection
        query={links}
        rows={rows}
        variant="list"
        emptyMessage="No archived links. Links you archive will show up here."
      >
        {(link) => (
          <RowCard
            key={link.id}
            tile={
              <RowCardTile>
                <Link2 className="size-4" />
              </RowCardTile>
            }
            actions={
              <>
                <IconButton icon={RotateCcw} label="Restore link" onClick={() => restore(link)} />
                <ConfirmButton
                  className="size-10"
                  ariaLabel="Delete permanently"
                  title={`Purge ${shortLinkText(link)}?`}
                  description="This destroys the link and every visit ever recorded on it. It cannot be undone, and the slug becomes free for reuse on this domain."
                  confirmLabel="Purge for good"
                  confirmText={link.slug}
                  onConfirm={() => purge(link)}
                >
                  <Trash2 />
                </ConfirmButton>
              </>
            }
          >
            <ShortLink link={link} />
            <span className="truncate text-xs text-muted-foreground">
              {link.destination} · Archived <When iso={link.updated_at} relative />
            </span>
          </RowCard>
        )}
      </Collection>
    </>
  )
}
