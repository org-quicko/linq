"use client"

import { type Actor, can, type Link, type Page } from "@linq/shared"
import {
  Archive,
  ArrowDownIcon,
  ArrowUpIcon,
  BarChart3,
  Copy,
  CornerDownRight,
  Globe,
  Link2,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { AppShell } from "@/components/app-shell"
import { When } from "@/components/common"
import { LinkFormDialog } from "@/components/link-form-dialog"
import {
  Collection,
  DomainPicker,
  IconButton,
  PageHeader,
  RowCard,
  RowCardTile,
  ShortLink,
  Tag,
} from "@/components/patterns"
import { ShareMenu } from "@/components/share-menu"
import { TagPicker } from "@/components/tag-picker"
import { Button } from "@/components/ui/button"
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { useDebounced, useRun } from "../../lib/hooks"
import { useArchiveLinkMutation, useLinksFeedInfiniteQuery } from "../../lib/store/links"

type Filters = { domain_id: string; order: "asc" | "desc" }
const EMPTY: Filters = { domain_id: "", order: "desc" }

/** Create/Edit/Duplicate all go through one dialog; `null` means closed. */
type DialogState = { mode: "create" | "edit"; link?: Link } | null

/** The main list: every active link, filtered the same way the API filters them. */
export default function LinksPage() {
  return <AppShell>{(actor) => <LinksList actor={actor} />}</AppShell>
}

function LinksList({ actor }: { actor: Actor }) {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [search, setSearch] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [dialog, setDialog] = useState<DialogState>(null)

  // The box stays responsive while the request waits for the typing to stop.
  const settledSearch = useDebounced(search)

  const links = useLinksFeedInfiniteQuery({
    domain_id: filters.domain_id || undefined,
    order: filters.order,
    search: settledSearch || undefined,
    tags: tags.join(",") || undefined,
  })

  const rows = links.data?.pages.flatMap((page: Page<Link>) => page.data) ?? []

  // A bare sentinel div, observed natively — no library. Plus an explicit
  // "Load more" button behind it: the observer alone has no keyboard or
  // screen-reader path to the next page.
  const sentinel = useRef<HTMLDivElement>(null)
  const hasNextPage = links.hasNextPage ?? false
  const isFetchingNextPage = links.isFetchingNextPage
  const { fetchNextPage } = links
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasNextPage) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !isFetchingNextPage) fetchNextPage()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pinned: only the list below scrolls (plans/Plan_31.md §B5). */}
      <div className="flex shrink-0 flex-col gap-4 px-7 pt-6 pb-4">
        <PageHeader
          title="Short links"
          actions={
            can.createLink(actor) ? (
              <Button type="button" onClick={() => setDialog({ mode: "create" })}>
                <Plus className="size-3.5" />
                Create link
              </Button>
            ) : null
          }
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="w-[300px]">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                placeholder="Search links"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                  >
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>

            <TagPicker
              value={tags}
              onChange={setTags}
              placeholder="Tag"
              selectedLabel={(n) => `Tag (${n})`}
              showChips={false}
              className="w-auto"
            />

            <DomainPicker
              multiple
              value={filters.domain_id}
              onChange={(domain_id) => setFilters((f) => ({ ...f, domain_id }))}
            />
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setFilters((f) => ({ ...f, order: f.order === "desc" ? "asc" : "desc" }))
            }
          >
            {filters.order === "desc" ? "Newest to Oldest" : "Oldest to Newest"}
            {filters.order === "desc" ? <ArrowDownIcon /> : <ArrowUpIcon />}
          </Button>
        </div>
      </div>

      {/* Scrolls on its own; the header and toolbar above stay put. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-6">
        <Collection
          query={links}
          rows={rows}
          variant="list"
          emptyMessage="No links match your search."
        >
          {(link: Link) => (
            <LinkRow
              key={link.id}
              actor={actor}
              link={link}
              onEdit={() => setDialog({ mode: "edit", link })}
              onDuplicate={() => setDialog({ mode: "create", link })}
            />
          )}
        </Collection>

        {hasNextPage ? (
          <div ref={sentinel} className="flex justify-center py-2">
            <Button
              type="button"
              variant="outline"
              disabled={isFetchingNextPage}
              onClick={() => links.fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : rows.length > 0 ? (
          <div className="flex items-center gap-3 py-2 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            These were all the links you had.
            <div className="h-px flex-1 bg-border" />
          </div>
        ) : null}
      </div>

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
  // More than one rule reads as "this link routes dynamically" — a single
  // rule is still just one alternate destination, not a decision tree.
  const routesDynamically = link.rule_count > 1

  return (
    <>
      <RowCard
        tile={
          <RowCardTile>
            {link.icon_url ? (
              // biome-ignore lint/performance/noImgElement: arbitrary external favicons cannot be routed through next/image
              <img
                src={link.icon_url}
                alt=""
                className="size-4"
                onError={(e) => {
                  e.currentTarget.style.display = "none"
                }}
              />
            ) : null}
            {!link.icon_url ? (
              routesDynamically ? (
                <Globe className="size-4" />
              ) : (
                <Link2 className="size-4" />
              )
            ) : null}
          </RowCardTile>
        }
        className="px-5 py-3"
        actions={
          <>
            <IconButton
              icon={BarChart3}
              label="View analytics"
              onClick={() => router.push(`/analytics/?link_id=${link.id}`)}
            />
            <ShareMenu link={link} />
            {editable || duplicatable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton icon={MoreVertical} label="Row actions" />
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
                  {editable ? (
                    <DropdownMenuItem onClick={() => setConfirmArchive(true)}>
                      <Archive />
                      Archive
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
      >
        <div className="flex items-center gap-2 min-w-0">
          {link.name ? <span className="truncate text-sm font-semibold">{link.name}</span> : null}
          <ShortLink link={link} className="text-[12.5px] font-medium text-foreground" />
        </div>
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <CornerDownRight className="size-3 shrink-0" />
          <span className="truncate">
            {routesDynamically ? "Routes dynamically" : link.destination}
          </span>
          <span aria-hidden>·</span>
          <When iso={link.created_at} relative />
        </span>
        {link.tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {link.tags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
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
              Archive {link.domain_host}/{link.slug}?
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
