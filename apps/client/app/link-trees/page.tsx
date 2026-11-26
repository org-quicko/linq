"use client"

import { type Actor, type Link, type Page, PermissionUtil } from "@linq/shared"
import {
  Archive,
  BarChart3,
  Copy,
  ListTree,
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
import { LinkTreeFormDialog } from "@/components/link-tree-form-dialog"
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

/** Create, Edit and Duplicate all go through one dialog; `null` means closed. */
type DialogState = { mode: "create" | "edit"; link?: Link } | null

/** Every active Link Tree: one short link per page of links. */
export default function LinkTreesPage() {
  return <AppShell>{(actor) => <LinkTreesList actor={actor} />}</AppShell>
}

function LinkTreesList({ actor }: { actor: Actor }) {
  const [search, setSearch] = useState("")
  const [domain_id, setDomainId] = useState("")
  const [dialog, setDialog] = useState<DialogState>(null)
  const settledSearch = useDebounced(search)

  const trees = useLinksFeedInfiniteQuery({
    type: "tree",
    order: "desc",
    domain_id: domain_id || undefined,
    search: settledSearch || undefined,
  })
  const rows = trees.data?.pages.flatMap((page: Page<Link>) => page.data) ?? []
  const filtering = Boolean(settledSearch || domain_id)

  // The same sentinel-plus-button paging as Short links.
  const sentinel = useRef<HTMLDivElement>(null)
  const hasNextPage = trees.hasNextPage ?? false
  const isFetchingNextPage = trees.isFetchingNextPage
  const { fetchNextPage } = trees
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
      <div className="flex shrink-0 flex-col gap-4 px-7 pt-6 pb-4">
        <PageHeader
          title="Link Trees"
          description="A single short link that opens a page of your other links."
          actions={
            PermissionUtil.can.createLink(actor) ? (
              <Button type="button" onClick={() => setDialog({ mode: "create" })}>
                <Plus className="size-3.5" />
                Create link tree
              </Button>
            ) : null
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-[300px]">
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search link trees"
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
          <DomainPicker multiple value={domain_id} onChange={setDomainId} />
        </div>
      </div>

      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-7 pb-6">
        <Collection
          query={trees}
          rows={rows}
          variant="list"
          emptyMessage={filtering ? "No link trees match your search." : "No link trees yet."}
          emptyIcon={filtering ? Search : ListTree}
        >
          {(link: Link) => (
            <LinkTreeRow
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
              onClick={() => trees.fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>

      {dialog ? (
        <LinkTreeFormDialog
          key={`${dialog.mode}-${dialog.link?.id ?? "new"}`}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          mode={dialog.mode}
          link={dialog.link}
        />
      ) : null}
    </div>
  )
}

function LinkTreeRow({
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

  const editable = PermissionUtil.can.editLink(actor)
  const duplicatable = PermissionUtil.can.createLink(actor)
  const archivable = PermissionUtil.can.archiveLink(actor)
  const items = `${link.item_count} ${link.item_count === 1 ? "item" : "items"}`

  return (
    <>
      <RowCard
        className="px-5 py-3"
        tile={
          <RowCardTile>
            <ListTree className="size-4" />
          </RowCardTile>
        }
        actions={
          <>
            <IconButton
              icon={BarChart3}
              label="View analytics"
              onClick={() => router.push(`/analytics/?link_id=${link.id}`)}
            />
            <ShareMenu link={link} />
            {editable || duplicatable || archivable ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton icon={MoreVertical} label="More options" />
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
                  {archivable ? (
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
        <div className="flex min-w-0 items-center gap-2">
          {link.name ? <span className="truncate text-sm font-semibold">{link.name}</span> : null}
          <ShortLink link={link} className="text-[12.5px] font-medium text-foreground" />
        </div>
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <span>{items}</span>
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

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Archive {link.domain_host}/{link.slug}?
            </DialogTitle>
            <DialogDescription>
              The page stops loading immediately. The short links it lists keep working, and you can
              restore the page later.
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
                run(() => archiveLink(link.id).unwrap(), {
                  fallback: "Could not archive that link tree.",
                })
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
