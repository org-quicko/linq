"use client"

import { can, type Domain, type Link } from "@linq/shared"
import { Globe, Link2, RotateCcw, Trash2 } from "lucide-react"
import { Suspense } from "react"
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
  TabShell,
} from "@/components/patterns"
import { useRun } from "../../lib/hooks"
import { useListDomainsQuery, usePurgeDomainMutation } from "../../lib/store/domains"
import {
  useListLinksQuery,
  usePurgeLinkMutation,
  useUpdateLinkMutation,
} from "../../lib/store/links"

/**
 * Archived links and archived domains, as tabs of one page rather than two
 * separate trash pages — merging plans/Plan_27.md Part C2. Restoring a link
 * happens here now (it used to live only on the main list); a domain has no
 * restore action here or anywhere else it did not already have, since only
 * an admin's archive/restore toggle on Settings → Domains ever offered one.
 *
 * `requires={can.purge}` is unchanged from both source pages: archived rows
 * are kept forever (docs/adr/0002) and purge is the only way to remove one,
 * so reaching this page at all is already an admin-only action.
 */
export default function ArchivesPage() {
  return (
    // useSearchParams (inside TabShell) needs a Suspense boundary under the App Router.
    <Suspense fallback={<p className="p-8 text-sm text-muted-foreground">Loading…</p>}>
      <AppShell requires={can.purge}>{() => <Archives />}</AppShell>
    </Suspense>
  )
}

function Archives() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-7 py-6">
      <PageHeader
        title="Archives"
        description="Archived links and domains. Purging either is permanent."
      />

      <TabShell
        basePath="/archives/"
        defaultTab="links"
        tabs={[
          { value: "links", label: "Links", content: <ArchivedLinksTab /> },
          { value: "domains", label: "Domains", content: <ArchivedDomainsTab /> },
        ]}
      />
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

function ArchivedDomainsTab() {
  const domains = useListDomainsQuery({ limit: 200 })
  const rows = (domains.data?.data ?? []).filter((domain) => domain.status === "archived")
  const [purgeDomain] = usePurgeDomainMutation()
  const { run } = useRun()

  function purge(domain: Domain) {
    return run(() => purgeDomain(domain.id).unwrap())
  }

  return (
    <Collection query={domains} rows={rows} variant="list" emptyMessage="Nothing archived.">
      {(domain) => (
        <RowCard
          key={domain.id}
          tile={
            <RowCardTile>
              <Globe className="size-4" />
            </RowCardTile>
          }
          actions={
            <ConfirmButton
              className="size-10"
              ariaLabel="Delete permanently"
              title={`Purge ${domain.host}?`}
              description="This destroys the domain and every visit ever recorded on it. It cannot be undone. The server refuses this while any link still points at the host, archived ones included."
              confirmLabel="Purge for good"
              confirmText={domain.host}
              onConfirm={() => purge(domain)}
            >
              <Trash2 />
            </ConfirmButton>
          }
        >
          <span className="truncate font-medium">{domain.host}</span>
          <span className="truncate text-xs text-muted-foreground">
            {domain.fallback_url ?? "404 when blank"} · {domain.link_count} link
            {domain.link_count === 1 ? "" : "s"}
          </span>
        </RowCard>
      )}
    </Collection>
  )
}
