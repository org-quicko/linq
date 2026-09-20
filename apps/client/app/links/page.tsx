"use client"

import { type Actor, can, type Link } from "@linq/shared"
import {
  Archive,
  ArrowDownIcon,
  ArrowUpIcon,
  Copy,
  Link2,
  MoreVertical,
  Pencil,
} from "lucide-react"
import NextLink from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Pager, Picker } from "@/components/common"
import { LinkFormDialog } from "@/components/link-form-dialog"
import {
  Collection,
  DomainPicker,
  PageHeader,
  RowCard,
  RowCardTile,
  ShortLink,
} from "@/components/patterns"
import { TagPicker } from "@/components/tag-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useDebounced, useRun } from "../../lib/hooks"
import { useArchiveLinkMutation, useListLinksQuery } from "../../lib/store/links"

type Filters = {
  domainId: string
  status: "active" | "archived" | "all"
  sort: "createdAt" | "updatedAt" | "visits"
  order: "asc" | "desc"
}

const EMPTY: Filters = { domainId: "", status: "active", sort: "createdAt", order: "desc" }

/** Create/Edit/Duplicate all go through one dialog (Part C4); `null` means closed. */
type DialogState = { mode: "create" | "edit"; link?: Link } | null

/** The main list: every link, filtered the same way the API filters them. */
export default function LinksPage() {
  return <AppShell>{(actor) => <LinksList actor={actor} />}</AppShell>
}

function LinksList({ actor }: { actor: Actor }) {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [search, setSearch] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [dialog, setDialog] = useState<DialogState>(null)
  const limit = 25

  // The box stays responsive while the request waits for the typing to stop.
  const settledSearch = useDebounced(search)

  const links = useListLinksQuery({
    ...filters,
    search: settledSearch,
    tags: tags.join(","),
    limit,
    offset,
  })

  /** Applies a filter change and returns to the first page of results. */
  function update(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }))
    setOffset(0)
  }

  const rows = links.data?.data ?? []
  const total = links.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Short links"
        actions={
          can.createLink(actor) ? (
            <Button type="button" onClick={() => setDialog({ mode: "create" })}>
              Create link
            </Button>
          ) : null
        }
      />

      <Card>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            placeholder="Search slug, name or destination"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setOffset(0)
            }}
          />
          <TagPicker
            value={tags}
            placeholder="Any tag"
            onChange={(next) => {
              setTags(next)
              setOffset(0)
            }}
          />
          <DomainPicker value={filters.domainId} onChange={(domainId) => update({ domainId })} />
          <Picker
            value={filters.status}
            onChange={(value) => update({ status: value as Filters["status"] })}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
          <div className="flex gap-2">
            <Picker
              className="flex-1"
              value={filters.sort}
              onChange={(value) => update({ sort: value as Filters["sort"] })}
              options={[
                { value: "createdAt", label: "Created" },
                { value: "updatedAt", label: "Updated" },
                { value: "visits", label: "Visits" },
              ]}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={filters.order === "desc" ? "Sorted descending" : "Sorted ascending"}
              onClick={() => update({ order: filters.order === "desc" ? "asc" : "desc" })}
            >
              {filters.order === "desc" ? <ArrowDownIcon /> : <ArrowUpIcon />}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Collection
        query={links}
        rows={rows}
        variant="list"
        emptyMessage="No links match these filters."
      >
        {(link) => (
          <LinkRow
            key={link.id}
            actor={actor}
            link={link}
            onEdit={() => setDialog({ mode: "edit", link })}
            onDuplicate={() => setDialog({ mode: "create", link })}
          />
        )}
      </Collection>

      <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />

      {dialog ? (
        <LinkFormDialog
          key={`${dialog.mode}-${dialog.link?.id ?? "new"}`}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          actor={actor}
          mode={dialog.mode}
          link={dialog.link}
        />
      ) : null}
    </div>
  )
}

function LinkRow({
  actor,
  link,
  onEdit,
  onDuplicate,
}: {
  actor: Actor
  link: Link
  onEdit: () => void
  onDuplicate: () => void
}) {
  const router = useRouter()
  const [archiveLink] = useArchiveLinkMutation()
  const { run } = useRun()
  const [confirmArchive, setConfirmArchive] = useState(false)

  const editable = can.editLink(actor, link)
  const duplicatable = can.createLink(actor)

  return (
    <>
      <RowCard
        tile={
          <RowCardTile>
            <Link2 className="size-4" />
          </RowCardTile>
        }
        className={link.status === "archived" ? "opacity-60" : undefined}
        onClick={() => router.push(`/links/${link.id}/summary/`)}
        actions={
          editable || duplicatable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-10"
                  aria-label="Row actions"
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {editable ? (
                  <DropdownMenuItem onClick={onEdit}>
                    <Pencil />
                    Edit
                  </DropdownMenuItem>
                ) : null}
                {duplicatable ? (
                  <DropdownMenuItem onClick={onDuplicate}>
                    <Copy />
                    Duplicate
                  </DropdownMenuItem>
                ) : null}
                {editable && link.status === "active" ? (
                  <DropdownMenuItem onClick={() => setConfirmArchive(true)}>
                    <Archive />
                    Archive
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      >
        <div className="flex items-center gap-2 min-w-0">
          {link.name ? (
            <NextLink
              href={`/links/${link.id}/summary/`}
              className="truncate font-medium underline-offset-2 hover:underline"
            >
              {link.name}
            </NextLink>
          ) : null}
          <ShortLink link={link} href={`/links/${link.id}/summary/`} />
          {link.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
          {link.expiresAt && new Date(link.expiresAt) <= new Date() ? (
            <Badge variant="outline">Expired</Badge>
          ) : null}
        </div>
        <span className="truncate text-xs text-muted-foreground">{link.destination}</span>
        {link.tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {link.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </RowCard>

      {/* Adopts the detail page's confirm-before-archive behaviour here too
          (plans/Plan_27.md Part B3): the two used to disagree on the same action. */}
      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Archive {link.domainHost}/{link.slug}?
            </DialogTitle>
            <DialogDescription>
              The short URL stops resolving immediately. Nothing is deleted, and the slug stays
              taken, so you can restore it later.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmArchive(false)
                run(() => archiveLink(link.id).unwrap())
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
