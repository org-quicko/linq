"use client"

import { type Actor, can, type Link } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import NextLink from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, Field, Picker, QueryState, When } from "@/components/common"
import { PageHeader, ShortLink } from "@/components/patterns"
import {
  type PresetParamRow,
  PresetParamsEditor,
  presetParamsToRows,
  rowsToPresetParams,
} from "@/components/preset-params-editor"
import { RulesEditor } from "@/components/rules-editor"
import { StatsPanel } from "@/components/stats-panel"
import { TagPicker } from "@/components/tag-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { VisitsCard } from "@/components/visits-card"
import { fromDatetimeLocal, toDatetimeLocal } from "../../../lib/api"
import { useRun } from "../../../lib/hooks"
import { useListKeysQuery } from "../../../lib/store/keys"
import {
  useArchiveLinkMutation,
  useGetLinkQuery,
  useGetLinkRulesQuery,
  usePurgeLinkMutation,
  useUpdateLinkMutation,
} from "../../../lib/store/links"

/**
 * Everything about one link: its settings, its rules, its visit history.
 *
 * The id arrives in the query string rather than the path because the Client UI
 * is a static export, which cannot pre-render a page per link id.
 */
export default function LinkDetailPage() {
  return (
    // useSearchParams needs a Suspense boundary under the App Router.
    <Suspense fallback={<p className="p-8 text-sm text-muted-foreground">Loading…</p>}>
      <AppShell>{(actor) => <LinkDetail actor={actor} />}</AppShell>
    </Suspense>
  )
}

function LinkDetail({ actor }: { actor: Actor }) {
  const id = useSearchParams().get("id")
  const link = useGetLinkQuery(id ?? skipToken)
  const rules = useGetLinkRulesQuery(id ?? skipToken)

  if (!id) return <p className="text-sm text-destructive">No link id in the URL.</p>
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

      <SettingsCard
        link={current}
        canEdit={canEdit}
        canTransfer={can.transferLink(actor, current)}
        canPurge={can.purge(actor)}
      />

      {rules.data ? (
        <RulesEditor linkId={id} rules={rules.data} readOnly={!canEdit} />
      ) : (
        <QueryState isLoading={rules.isLoading} error={rules.error} />
      )}

      <VisitsCard scope={{ linkId: id }} />
    </div>
  )
}

/** The editable fields of a link. Slug and domain are shown but never editable. */
function SettingsCard({
  link,
  canEdit,
  canTransfer,
  canPurge,
}: {
  link: Link
  canEdit: boolean
  /** Decided from the calling key, never from the draft owner in the dropdown. */
  canTransfer: boolean
  canPurge: boolean
}) {
  const router = useRouter()
  const keys = useListKeysQuery({ limit: 200 })
  const [updateLink] = useUpdateLinkMutation()
  const [archiveLink] = useArchiveLinkMutation()
  const [purgeLink] = usePurgeLinkMutation()
  const [destination, setDestination] = useState(link.destination)
  const [name, setName] = useState(link.name ?? "")
  const [tags, setTags] = useState<string[]>(link.tags)
  const [forwardQuery, setForwardQuery] = useState(link.forwardQuery)
  const [presetParams, setPresetParams] = useState<PresetParamRow[]>(() =>
    presetParamsToRows(link.presetParams),
  )
  const [ownerId, setOwnerId] = useState(link.ownerId ?? "")
  const [expiresAt, setExpiresAt] = useState(() => toDatetimeLocal(link.expiresAt))
  const [listed, setListed] = useState(link.listed)
  const { run, saving } = useRun()

  function save() {
    return run(
      () =>
        updateLink({
          id: link.id,
          body: {
            destination: destination.trim(),
            name: name.trim() || null,
            tags,
            forwardQuery,
            presetParams: rowsToPresetParams(presetParams),
            expiresAt: fromDatetimeLocal(expiresAt),
            listed,
            ...(ownerId !== link.ownerId ? { ownerId } : {}),
          },
        }).unwrap(),
      { success: "Saved.", fallback: "Could not save." },
    )
  }

  function toggleArchived() {
    return run(() =>
      link.status === "active"
        ? archiveLink(link.id).unwrap()
        : updateLink({ id: link.id, body: { status: "active" } }).unwrap(),
    )
  }

  /** There is no row left to reload afterwards, so this leaves the page. */
  function purge() {
    return run(() => purgeLink(link.id).unwrap(), {
      success: `Purged /${link.slug}. The slug is free again.`,
      onSuccess: () => router.push("/links/"),
    })
  }

  return (
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
                {/* Archived only: purge is the step after archiving, never an
                    alternative to it, and the server enforces that too. */}
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
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Destination" hint="Where visitors go when no rule matches.">
            <Input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Name">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Tags" hint="Pick one in use, or add a new one.">
            <TagPicker value={tags} onChange={setTags} creatable disabled={!canEdit} />
          </Field>

          <Field
            label="Owner"
            hint={
              canTransfer
                ? "Handing this to another key gives up your own access unless your role covers it."
                : "Only an admin, or the owning key, may hand a link over."
            }
          >
            <Picker
              value={ownerId}
              disabled={!canEdit || !canTransfer}
              onChange={setOwnerId}
              options={(keys.data?.data ?? [])
                // The server refuses a viewer as an owner, so never offer
                // one — except the current owner, which may already be a
                // viewer via a demotion and must still render as the truth.
                .filter((key) => can.ownLink(key) || key.id === link.ownerId)
                .map((key) => ({ value: key.id, label: key.name }))}
            />
          </Field>

          <Field label="Slug" hint="Immutable, and never reused once taken.">
            <Input value={link.slug} disabled readOnly />
          </Field>

          <Field label="Domain" hint="Immutable.">
            <Input value={link.domainHost} disabled readOnly />
          </Field>

          <Field
            label="Expires"
            hint="Leave blank to never expire. Past this, the link 404s like an unknown slug."
          >
            <Input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              disabled={!canEdit}
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field
            label="Preset params"
            hint="Set on the destination at redirect time, overriding its own query and any forwarded one."
          >
            <PresetParamsEditor
              rows={presetParams}
              onChange={setPresetParams}
              readOnly={!canEdit}
              forwardQuery={forwardQuery}
            />
          </Field>
        </div>

        <Label className="mt-4 font-normal">
          <Checkbox
            checked={forwardQuery}
            disabled={!canEdit}
            onCheckedChange={(checked) => setForwardQuery(checked === true)}
          />
          Forward incoming query parameters to the destination
        </Label>

        <Label className="mt-2 font-normal">
          <Checkbox
            checked={listed}
            disabled={!canEdit}
            onCheckedChange={(checked) => setListed(checked === true)}
          />
          List in /llms.txt — publishes this link's name and destination, readable without a key
        </Label>
      </CardContent>
    </Card>
  )
}
