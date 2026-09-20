"use client"

import { type Actor, can, type Link } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import NextLink from "next/link"
import { useParams, usePathname, useRouter } from "next/navigation"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, Field, QueryState, When } from "@/components/common"
import { LinkFormDialog } from "@/components/link-form-dialog"
import { PageHeader, ShortLink } from "@/components/patterns"
import { RulesEditor } from "@/components/rules-editor"
import { StatsPanel } from "@/components/stats-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { VisitsCard } from "@/components/visits-card"
import { useRun } from "../../../../lib/hooks"
import {
  useArchiveLinkMutation,
  useGetLinkQuery,
  useGetLinkRulesQuery,
  usePurgeLinkMutation,
  useUpdateLinkMutation,
} from "../../../../lib/store/links"

/**
 * Summary view of one link: settings, routing rules, statistics, and visit history.
 * Routed at /links/{id}/summary — no query parameters needed.
 */
export function LinkSummaryClient({ id: initialId }: { id?: string }) {
  const params = useParams<{ id: string }>()
  const pathname = usePathname()
  const rawId =
    initialId && initialId !== "_summary"
      ? initialId
      : params?.id && params.id !== "_summary"
        ? params.id
        : pathname.match(/\/links\/([^/]+)\/summary/)?.[1]
  const id = rawId ? decodeURIComponent(rawId) : undefined

  return <AppShell>{(actor) => <LinkSummaryContent actor={actor} id={id} />}</AppShell>
}

function LinkSummaryContent({ actor, id }: { actor: Actor; id?: string }) {
  const link = useGetLinkQuery(id ?? skipToken)
  const rules = useGetLinkRulesQuery(id ?? skipToken)

  if (!id) return <p className="p-8 text-sm text-destructive">No link id in the URL.</p>
  if (link.isLoading || !link.data) {
    return <QueryState isLoading={link.isLoading} error={link.error} />
  }

  const current = link.data
  const canEdit = can.editLink(actor, current)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={
          <>
            <ShortLink link={current} />
            {current.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
            {current.expiresAt && new Date(current.expiresAt) <= new Date() ? (
              <Badge variant="outline">Expired</Badge>
            ) : null}
          </>
        }
        description={
          <>
            Created <When iso={current.createdAt} /> by {current.ownerName ?? "a revoked key"}
          </>
        }
        actions={
          <NextLink href="/links/">
            <Button type="button" variant="outline">
              Back to links
            </Button>
          </NextLink>
        }
      />

      <StatsPanel path={`/v1/links/${id}/stats`} title="Visits" />

      <SummaryCard actor={actor} link={current} canEdit={canEdit} canPurge={can.purge(actor)} />

      {rules.data ? (
        <RulesEditor linkId={id} rules={rules.data} readOnly={!canEdit} />
      ) : (
        <QueryState isLoading={rules.isLoading} error={rules.error} />
      )}

      <VisitsCard scope={{ linkId: id }} />
    </div>
  )
}

function SummaryCard({
  actor,
  link,
  canEdit,
  canPurge,
}: {
  actor: Actor
  link: Link
  canEdit: boolean
  canPurge: boolean
}) {
  const router = useRouter()
  const [archiveLink] = useArchiveLinkMutation()
  const [updateLink] = useUpdateLinkMutation()
  const [purgeLink] = usePurgeLinkMutation()
  const [editOpen, setEditOpen] = useState(false)
  const { run } = useRun()

  function toggleArchived() {
    return run(async () => {
      if (link.status === "active") await archiveLink(link.id).unwrap()
      else await updateLink({ id: link.id, body: { status: "active" } }).unwrap()
    })
  }

  function purge() {
    return run(() => purgeLink(link.id).unwrap(), {
      success: `Purged /${link.slug}. The slug is free again.`,
      onSuccess: () => router.push("/links/"),
    })
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Settings</CardTitle>
          {canEdit ? (
            <CardAction className="flex gap-2">
              {link.status === "active" ? (
                <ConfirmButton
                  title={`Archive ${link.domainHost}/${link.slug}?`}
                  description="The short URL stops resolving immediately. Nothing is deleted, and the slug stays taken, so you can restore it later."
                  confirmLabel="Archive"
                  onConfirm={toggleArchived}
                >
                  Archive
                </ConfirmButton>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={toggleArchived}>
                    Restore
                  </Button>
                  {canPurge ? (
                    <ConfirmButton
                      title={`Purge ${link.domainHost}/${link.slug}?`}
                      description={`This destroys the link and its rules for good, and frees the slug for anyone to claim on ${link.domainHost}. Its visits are kept as orphans. It cannot be undone.`}
                      confirmLabel="Purge for good"
                      confirmText={link.slug}
                      onConfirm={purge}
                    >
                      Purge
                    </ConfirmButton>
                  ) : null}
                </>
              )}
              <Button type="button" onClick={() => setEditOpen(true)}>
                Edit
              </Button>
            </CardAction>
          ) : null}
        </CardHeader>

        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Destination">
            <p className="truncate text-sm">{link.destination}</p>
          </Field>
          <Field label="Name">
            <p className="truncate text-sm text-muted-foreground">{link.name || "—"}</p>
          </Field>
          <Field label="Tags">
            <p className="text-sm text-muted-foreground">
              {link.tags.length > 0 ? link.tags.join(", ") : "—"}
            </p>
          </Field>
          <Field label="Owner">
            <p className="text-sm text-muted-foreground">{link.ownerName ?? "unassigned"}</p>
          </Field>
          <Field label="Slug" hint="Immutable, and never reused once taken.">
            <p className="text-sm text-muted-foreground">{link.slug}</p>
          </Field>
          <Field label="Domain" hint="Immutable.">
            <p className="text-sm text-muted-foreground">{link.domainHost}</p>
          </Field>
          <Field label="Expires">
            <p className="text-sm text-muted-foreground">
              {link.expiresAt ? <When iso={link.expiresAt} /> : "never"}
            </p>
          </Field>
          <Field label="Forward query params">
            <p className="text-sm text-muted-foreground">{link.forwardQuery ? "Yes" : "No"}</p>
          </Field>
          <Field label="Listed in /llms.txt">
            <p className="text-sm text-muted-foreground">{link.listed ? "Yes" : "No"}</p>
          </Field>
        </CardContent>
      </Card>

      {editOpen ? (
        <LinkFormDialog open onOpenChange={setEditOpen} actor={actor} mode="edit" link={link} />
      ) : null}
    </>
  )
}
