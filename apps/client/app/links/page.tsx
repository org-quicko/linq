"use client"

import { type Actor, can, type Link } from "@linq/shared"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import NextLink from "next/link"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import { Pager, Picker, When } from "@/components/common"
import { Collection, DomainPicker, PageHeader, ShortLink } from "@/components/patterns"
import { TagPicker } from "@/components/tag-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { qs } from "../../lib/api"
import { useDebounced, useRun } from "../../lib/hooks"
import {
  useArchiveLinkMutation,
  useListLinksQuery,
  useUpdateLinkMutation,
} from "../../lib/store/links"

type Filters = {
  domainId: string
  status: "active" | "archived" | "all"
  sort: "createdAt" | "updatedAt" | "visits"
  order: "asc" | "desc"
}

const EMPTY: Filters = { domainId: "", status: "active", sort: "createdAt", order: "desc" }

const HEAD = ["Short URL", "Destination", "Tags", "Visits", "Owner", "Updated", "", ""]

/** The main list: every link, filtered the same way the API filters them. */
export default function LinksPage() {
  return <AppShell>{(actor) => <LinksList actor={actor} />}</AppShell>
}

function LinksList({ actor }: { actor: Actor }) {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [search, setSearch] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
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
  const [archiveLink] = useArchiveLinkMutation()
  const [updateLink] = useUpdateLinkMutation()
  const { run } = useRun()

  /** Applies a filter change and returns to the first page of results. */
  function update(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }))
    setOffset(0)
  }

  function toggleStatus(link: Link) {
    return run(() =>
      link.status === "active"
        ? archiveLink(link.id).unwrap()
        : updateLink({ id: link.id, body: { status: "active" } }).unwrap(),
    )
  }

  const rows = links.data?.data ?? []
  const total = links.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Links"
        actions={
          can.createLink(actor) ? (
            <NextLink href="/links/new/">
              <Button type="button">New link</Button>
            </NextLink>
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

      <Card>
        <CardContent>
          <Collection
            query={links}
            rows={rows}
            head={HEAD}
            emptyMessage="No links match these filters."
          >
            {(link) => (
              <TableRow
                key={link.id}
                className={link.status === "archived" ? "opacity-60" : undefined}
              >
                <TableCell className="max-w-xs">
                  <ShortLink link={link} href={`/links/detail/${qs({ id: link.id })}`} />
                  {link.name ? (
                    <div className="truncate text-xs text-muted-foreground">{link.name}</div>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-xs truncate text-muted-foreground">
                  <span title={link.destination}>{link.destination}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {link.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">
                  {link.humanVisits}
                  <span className="text-muted-foreground"> + {link.botVisits} bot</span>
                </TableCell>
                <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                  {link.ownerName ?? "—"}
                </TableCell>
                <TableCell>
                  <When iso={link.updatedAt} relative />
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {link.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
                    {link.expiresAt && new Date(link.expiresAt) <= new Date() ? (
                      <Badge variant="outline">Expired</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  {/* Per row, not per page: an author owns some of these and not
                      others, and the server refuses the rest with a 403. */}
                  {can.editLink(actor, link) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={link.status === "active" ? "destructive" : "outline"}
                      onClick={() => toggleStatus(link)}
                    >
                      {link.status === "active" ? "Archive" : "Restore"}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            )}
          </Collection>

          <Pager total={total} limit={limit} offset={offset} onChange={setOffset} />
        </CardContent>
      </Card>
    </div>
  )
}
