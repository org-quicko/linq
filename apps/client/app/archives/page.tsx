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
  usePurgeArchivedLinksMutation,
  usePurgeLinkMutation,
  useUpdateLinkMutation,
} from "../../lib/store/links"

/**
 * Archived links — domains don't live here: domain archive/restore/purge
 * moved onto Settings → Domains itself, which already
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
      <PageHeader title="Archives" description="Links removed from active use." />
      <ArchivedLinksTab />
    </div>
  )
}

function ArchivedLinksTab() {
  const links = useListLinksQuery({ status: "archived", limit: 200 })
  const rows = links.data?.data ?? []
  const [updateLink] = useUpdateLinkMutation()
  const [purgeLink] = usePurgeLinkMutation()
  const [purgeArchivedLinks] = usePurgeArchivedLinksMutation()
  const { run } = useRun()

  function restore(link: Link) {
    return run(() => updateLink({ id: link.id, body: { status: "active" } }).unwrap(), {
      fallback: "Could not restore that link.",
    })
  }

  function purge(link: Link) {
    return run(() => purgeLink(link.id).unwrap(), { fallback: "Could not delete that link." })
  }

  /** One call, server-side: `DELETE /v1/links/purge` destroys every archived
   *  link in one statement, not just the (at most 200) rows this tab has
   *  loaded — the old per-row fan-out could never reach past that page. */
  function emptyArchive() {
    return run(() => purgeArchivedLinks().unwrap(), {
      success: "Emptied the archive.",
      fallback: "Could not empty the archive.",
    })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Archived links stop redirecting and disappear from your short links list, but stay
          recoverable until you delete them for good.
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
