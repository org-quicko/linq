"use client"

import { type Actor, can, type Domain } from "@linq/shared"
import { Archive, Globe, PencilLine, RotateCcw } from "lucide-react"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, Field } from "@/components/common"
import { Collection, IconButton, PageHeader, RowCard, RowCardTile, SettingsNav } from "@/components/patterns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useRun } from "../../../lib/hooks"
import {
  useArchiveDomainMutation,
  useCreateDomainMutation,
  useListDomainsQuery,
  useUpdateDomainMutation,
} from "../../../lib/store/domains"

/**
 * Domains, moved under Settings alongside Keys — plans/Plan_27.md Part C3.
 * Everyone may read this page; only an admin sees the write controls.
 * Archiving is refused by the server while any link still points at the
 * domain, archived included, and that refusal is surfaced here rather than
 * pre-empted, so the rule lives in one place.
 */
export default function SettingsDomainsPage() {
  return (
    <AppShell>
      {(actor) => (
        <SettingsNav actor={actor}>
          <Domains actor={actor} />
        </SettingsNav>
      )}
    </AppShell>
  )
}

function Domains({ actor }: { actor: Actor }) {
  const domains = useListDomainsQuery({ limit: 200 })
  const rows = domains.data?.data ?? []
  const isAdmin = can.manageDomains(actor)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Domains" actions={isAdmin ? <AddDomainDialog /> : null} />

      <Collection query={domains} rows={rows} variant="list" emptyMessage="No domains yet.">
        {(domain) => <DomainRow key={domain.id} domain={domain} isAdmin={isAdmin} />}
      </Collection>
    </div>
  )
}

function DomainRow({ domain, isAdmin }: { domain: Domain; isAdmin: boolean }) {
  const [updateDomain] = useUpdateDomainMutation()
  const [archiveDomain] = useArchiveDomainMutation()
  const { run } = useRun()

  const toggleStatus = () =>
    run(async () => {
      if (domain.status === "active") await archiveDomain(domain.id).unwrap()
      else await updateDomain({ id: domain.id, body: { status: "active" } }).unwrap()
    })

  return (
    <RowCard
      tile={
        <RowCardTile>
          <Globe className="size-4" />
        </RowCardTile>
      }
      actions={
        isAdmin ? (
          <>
            <EditRedirectsDialog domain={domain} />
            {domain.status === "active" ? (
              <ConfirmButton
                className="size-10"
                ariaLabel="Archive"
                title={`Archive ${domain.host}?`}
                description="Every short URL on this host stops resolving, including its fallback. The server refuses this while any link, archived included, still points at this host. Purge them first."
                confirmLabel="Archive"
                onConfirm={toggleStatus}
              >
                <Archive />
              </ConfirmButton>
            ) : (
              <IconButton icon={RotateCcw} label="Restore" onClick={toggleStatus} />
            )}
          </>
        ) : null
      }
    >
      <span className="flex items-center gap-2 truncate font-medium">
        {domain.host}
        {domain.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {domain.fallbackUrl ? `Redirects unmatched slugs to ${domain.fallbackUrl}` : "404s on any unmatched slug"} ·{" "}
        {domain.linkCount} link{domain.linkCount === 1 ? "" : "s"}
      </span>
    </RowCard>
  )
}

/** The one field the schema has today; Part D adds two more to this same dialog. */
function EditRedirectsDialog({ domain }: { domain: Domain }) {
  const [updateDomain] = useUpdateDomainMutation()
  const [open, setOpen] = useState(false)
  const [fallbackUrl, setFallbackUrl] = useState(domain.fallbackUrl ?? "")
  const { run, saving } = useRun()

  const save = () =>
    run(
      () => updateDomain({ id: domain.id, body: { fallbackUrl: fallbackUrl.trim() || null } }).unwrap(),
      {
        success: "Redirects updated.",
        fallback: "Could not update that domain.",
        onSuccess: () => setOpen(false),
      },
    )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setFallbackUrl(domain.fallbackUrl ?? "")
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-10" aria-label="Edit redirects">
          <PencilLine />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Redirects — {domain.host}</DialogTitle>
          <DialogDescription>Where a slug on this host goes when nothing else matches.</DialogDescription>
        </DialogHeader>
        <Field label="Fallback URL" hint="An unknown slug goes here. Blank means 404.">
          <Input
            value={fallbackUrl}
            onChange={(event) => setFallbackUrl(event.target.value)}
            placeholder="https://example.com/"
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 440px, one field, Enter to submit — per the mockup's Add domain dialog. */
function AddDomainDialog() {
  const [createDomain] = useCreateDomainMutation()
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState("")
  const { run, saving } = useRun()

  const create = () =>
    run(() => createDomain({ host: host.trim(), fallbackUrl: null }).unwrap(), {
      fallback: "Could not add that domain.",
      onSuccess: () => {
        setOpen(false)
        setHost("")
      },
    })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm">
          Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            Point its DNS at linq. Include a port only for local use. Redirects can be set after.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (host.trim()) create()
          }}
        >
          <Field label="Host">
            <Input
              autoFocus
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="links.example.com"
            />
          </Field>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || !host.trim()} onClick={create}>
            Add domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
