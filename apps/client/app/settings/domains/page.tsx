"use client"

import { type Actor, can, type Domain } from "@linq/shared"
import { CornerDownRight, Globe, Plus, RotateCcw, Trash2 } from "lucide-react"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { ConfirmButton, Field } from "@/components/common"
import {
  Collection,
  IconButton,
  PageHeader,
  RowCard,
  RowCardTile,
  SettingsNav,
} from "@/components/patterns"
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
  usePurgeDomainMutation,
  useUpdateDomainMutation,
} from "../../../lib/store/domains"

/**
 * Domains, moved under Settings alongside Keys — docs/plans/Plan_27.md Part C3.
 * Everyone may read this page; only an admin sees the write controls.
 * Deleting a domain here is a hard delete, not an archive: it chains the
 * existing archive and purge calls so an admin never leaves a domain sitting
 * in the archived state, and the server's own archived-first check on purge
 * still runs, so the FK guard is still the source of truth. Refused (409)
 * while any link still points at the domain, archived included, and that
 * refusal is surfaced here rather than pre-empted, so the rule lives in one
 * place.
 */
export default function SettingsDomainsPage() {
  return (
    <AppShell>
      {(actor) => (
        <div className="no-scrollbar h-full min-h-0 overflow-y-auto px-7 py-6">
          <SettingsNav actor={actor}>
            <Domains actor={actor} />
          </SettingsNav>
        </div>
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
      <PageHeader
        title="Domains"
        description="Domains available when creating short links, with optional redirects."
        actions={isAdmin ? <AddDomainDialog /> : null}
      />

      <Collection query={domains} rows={rows} variant="list" emptyMessage="No domains yet.">
        {(domain) => <DomainRow key={domain.id} domain={domain} isAdmin={isAdmin} />}
      </Collection>
    </div>
  )
}

function DomainRow({ domain, isAdmin }: { domain: Domain; isAdmin: boolean }) {
  const [updateDomain] = useUpdateDomainMutation()
  const [archiveDomain] = useArchiveDomainMutation()
  const [purgeDomain] = usePurgeDomainMutation()
  const { run } = useRun()

  const restore = () => run(() => updateDomain({ id: domain.id, body: { status: "active" } }).unwrap())

  const remove = () =>
    run(
      async () => {
        await archiveDomain(domain.id).unwrap()
        await purgeDomain(domain.id).unwrap()
      },
      { success: "Domain deleted.", fallback: "Could not delete that domain." },
    )

  const redirectCount = [
    domain.base_path_redirect,
    domain.fallback_url,
    domain.invalid_short_url_redirect,
  ].filter(Boolean).length

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
                ariaLabel="Delete"
                title={`Delete ${domain.host}?`}
                description="Permanently deletes this domain and every visit ever recorded on it. This cannot be undone. Refused while any link, archived included, still points at this host — purge them first."
                confirmLabel="Delete"
                confirmText={domain.host}
                onConfirm={remove}
              >
                <Trash2 />
              </ConfirmButton>
            ) : (
              <IconButton icon={RotateCcw} label="Restore" onClick={restore} />
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
        {redirectCount
          ? `${redirectCount} redirect${redirectCount === 1 ? "" : "s"} configured`
          : "No redirects configured"}{" "}
        · {domain.link_count} link{domain.link_count === 1 ? "" : "s"}
      </span>
    </RowCard>
  )
}

/** Three redirect fields per mockup and Plan 27 Part D. */
function EditRedirectsDialog({ domain }: { domain: Domain }) {
  const [updateDomain] = useUpdateDomainMutation()
  const [open, setOpen] = useState(false)
  const [base_path_redirect, setBasePathRedirect] = useState(domain.base_path_redirect ?? "")
  const [fallback_url, setFallbackUrl] = useState(domain.fallback_url ?? "")
  const [invalid_short_url_redirect, setInvalidShortUrlRedirect] = useState(
    domain.invalid_short_url_redirect ?? "",
  )
  const { run, saving } = useRun()

  const save = () =>
    run(
      () =>
        updateDomain({
          id: domain.id,
          body: {
            base_path_redirect: base_path_redirect.trim() || null,
            fallback_url: fallback_url.trim() || null,
            invalid_short_url_redirect: invalid_short_url_redirect.trim() || null,
          },
        }).unwrap(),
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
        if (next) {
          setBasePathRedirect(domain.base_path_redirect ?? "")
          setFallbackUrl(domain.fallback_url ?? "")
          setInvalidShortUrlRedirect(domain.invalid_short_url_redirect ?? "")
        }
      }}
    >
      <DialogTrigger asChild>
        <IconButton icon={CornerDownRight} label="Edit redirects" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Redirects — {domain.host}</DialogTitle>
          <DialogDescription>
            Where a slug on this host goes when nothing else matches.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <Field
            label="Base path redirect"
            hint={`Where visitors land if they open ${domain.host} directly, with no short code.`}
          >
            <Input
              value={base_path_redirect}
              onChange={(event) => setBasePathRedirect(event.target.value)}
              placeholder="No redirect"
            />
          </Field>
          <Field
            label="Regular 404 redirect"
            hint="Where visitors land if the short code doesn't match any link."
          >
            <Input
              value={fallback_url}
              onChange={(event) => setFallbackUrl(event.target.value)}
              placeholder="No redirect"
            />
          </Field>
          <Field
            label="Invalid short URL redirect"
            hint="Where visitors land if the short code is malformed rather than simply missing."
          >
            <Input
              value={invalid_short_url_redirect}
              onChange={(event) => setInvalidShortUrlRedirect(event.target.value)}
              placeholder="No redirect"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving} onClick={save}>
            Save redirects
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
    run(() => createDomain({ host: host.trim(), fallback_url: null }).unwrap(), {
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
          <Plus className="size-3.5" />
          Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
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
          <Field label="Domain">
            <Input
              autoFocus
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="e.g. links.example.com"
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
