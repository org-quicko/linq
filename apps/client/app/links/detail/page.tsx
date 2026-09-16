"use client"

import {
  type Actor,
  type Click,
  can,
  type Link,
  type Page,
  type Rule,
  type UserSummary,
} from "@linq/shared"
import NextLink from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import {
  ConfirmButton,
  CopyButton,
  DataTable,
  Field,
  GeoAttribution,
  Picker,
  QueryState,
  When,
} from "@/components/common"
import { RulesEditor } from "@/components/rules-editor"
import { StatsPanel } from "@/components/stats-panel"
import { TagPicker } from "@/components/tag-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TableCell, TableRow } from "@/components/ui/table"
import { del, patch, qs } from "../../../lib/api"
import { useApi } from "../../../lib/use-api"

/**
 * Everything about one link: its settings, its rules, its click history.
 *
 * The id arrives in the query string rather than the path because the Admin UI
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
  const link = useApi<Link>(id ? `/v1/links/${id}` : null)
  const rules = useApi<Rule[]>(id ? `/v1/links/${id}/rules` : null)

  if (!id) return <p className="text-sm text-destructive">No link id in the URL.</p>
  if (link.loading || !link.data) {
    return <QueryState loading={link.loading} error={link.error} />
  }

  const current = link.data
  const canEdit = can.editLink(actor, current)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="flex items-center gap-2 font-heading text-xl font-semibold">
            {current.domainHost}/{current.slug}
            <CopyButton value={current.shortUrl} />
            {current.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
          </h1>
          <p className="text-sm text-muted-foreground">
            Created <When iso={current.createdAt} /> by {current.ownerName}
          </p>
        </div>
        <NextLink href="/links/" className="ml-auto">
          <Button type="button" variant="outline">
            Back to links
          </Button>
        </NextLink>
      </div>

      <StatsPanel path={`/v1/links/${id}/stats`} title="Clicks" />

      <SettingsCard
        link={current}
        canEdit={canEdit}
        canTransfer={can.transferLink(actor, current)}
        canPurge={can.purge(actor)}
        onSaved={link.reload}
      />

      {rules.data ? (
        <RulesEditor linkId={id} rules={rules.data} readOnly={!canEdit} onSaved={rules.reload} />
      ) : (
        <QueryState loading={rules.loading} error={rules.error} />
      )}

      <ClicksCard linkId={id} />
    </div>
  )
}

/** The editable fields of a link. Slug and domain are shown but never editable. */
function SettingsCard({
  link,
  canEdit,
  canTransfer,
  canPurge,
  onSaved,
}: {
  link: Link
  canEdit: boolean
  /** Decided from the signed-in user, never from the draft owner in the dropdown. */
  canTransfer: boolean
  canPurge: boolean
  onSaved: () => void
}) {
  const router = useRouter()
  const users = useApi<Page<UserSummary>>("/v1/users?limit=200")
  const [destination, setDestination] = useState(link.destination)
  const [name, setName] = useState(link.name ?? "")
  const [tags, setTags] = useState<string[]>(link.tags)
  const [forwardQuery, setForwardQuery] = useState(link.forwardQuery)
  const [ownerId, setOwnerId] = useState(link.ownerId)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await patch(`/v1/links/${link.id}`, {
        destination: destination.trim(),
        name: name.trim() || null,
        tags,
        forwardQuery,
        ...(ownerId !== link.ownerId ? { ownerId } : {}),
      })
      toast.success("Saved.")
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.")
    } finally {
      setSaving(false)
    }
  }

  async function toggleArchived() {
    try {
      if (link.status === "active") await del(`/v1/links/${link.id}`)
      else await patch(`/v1/links/${link.id}`, { status: "active" })
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    }
  }

  /** There is no row left to reload afterwards, so this leaves the page. */
  async function purge() {
    try {
      await del(`/v1/links/${link.id}/purge`)
      toast.success(`Purged /${link.slug}. The slug is free again.`)
      router.push("/links/")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    }
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
                    description={`This destroys the link and its rules for good, and frees the slug for anyone to claim on ${link.domainHost}. Its clicks are kept as orphans. It cannot be undone.`}
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
                ? "Handing this over gives up your own access unless your role covers it."
                : "Only an admin, or the owner, may hand a link over."
            }
          >
            <Picker
              value={ownerId}
              disabled={!canEdit || !canTransfer}
              onChange={setOwnerId}
              options={(users.data?.data ?? []).map((user) => ({
                value: user.id,
                label: user.name,
              }))}
            />
          </Field>

          <Field label="Slug" hint="Immutable, and never reused once taken.">
            <Input value={link.slug} disabled readOnly />
          </Field>

          <Field label="Domain" hint="Immutable.">
            <Input value={link.domainHost} disabled readOnly />
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
      </CardContent>
    </Card>
  )
}

/** The raw click log, newest first, with the human/bot filter the API offers. */
function ClicksCard({ linkId }: { linkId: string }) {
  const [bot, setBot] = useState<"any" | "true" | "false">("any")
  const clicks = useApi<Page<Click>>(`/v1/links/${linkId}/clicks${qs({ bot, limit: 25 })}`)
  const rows = clicks.data?.data ?? []

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Recent clicks</CardTitle>
        <CardAction>
          <Picker
            className="w-40"
            value={bot}
            onChange={(value) => setBot(value as typeof bot)}
            options={[
              { value: "any", label: "Everyone" },
              { value: "false", label: "Humans only" },
              { value: "true", label: "Bots only" },
            ]}
          />
        </CardAction>
      </CardHeader>

      <CardContent>
        <QueryState
          loading={clicks.loading}
          error={clicks.error}
          empty={rows.length === 0}
          emptyMessage="No clicks yet."
        />

        {rows.length > 0 ? (
          <DataTable head={["When", "Platform", "Location", "Referrer", "Sent to", ""]}>
            {rows.map((click) => (
              <TableRow key={click.id}>
                <TableCell>
                  <When iso={click.occurredAt} />
                </TableCell>
                <TableCell>{click.platform}</TableCell>
                <TableCell className="text-muted-foreground">
                  {[click.region, click.country].filter(Boolean).join(", ") || "—"}
                </TableCell>
                <TableCell className="max-w-[12rem] truncate text-muted-foreground">
                  {click.referer ?? "—"}
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                  <span title={click.destination ?? ""}>{click.destination ?? "—"}</span>
                </TableCell>
                <TableCell>{click.isBot ? <Badge variant="outline">Bot</Badge> : null}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        ) : null}

        <GeoAttribution />
      </CardContent>
    </Card>
  )
}
