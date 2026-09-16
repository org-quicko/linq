"use client"

import { type Actor, can, type Domain, type Link, type Page } from "@linq/shared"
import NextLink from "next/link"
import { useState } from "react"
import { toast } from "sonner"
import { AppShell } from "@/components/app-shell"
import { CopyButton, DataTable, Picker, QueryState } from "@/components/common"
import { TagPicker } from "@/components/tag-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { TableCell, TableRow } from "@/components/ui/table"
import { del, patch, qs } from "../../lib/api"
import { useApi, useDebounced } from "../../lib/use-api"

type Filters = {
  domainId: string
  status: "active" | "archived" | "all"
  sort: "createdAt" | "clicks"
}

const EMPTY: Filters = { domainId: "", status: "active", sort: "createdAt" }

/** Radix refuses an item whose value is "", so "no filter" needs a real value. */
const ANY_DOMAIN = "__any__"

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

  const domains = useApi<Page<Domain>>("/v1/domains?limit=200")
  const links = useApi<Page<Link>>(
    `/v1/links${qs({ ...filters, search: settledSearch, tags: tags.join(","), limit, offset })}`,
  )

  /** Applies a filter change and returns to the first page of results. */
  function update(next: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...next }))
    setOffset(0)
  }

  async function toggleStatus(link: Link) {
    try {
      if (link.status === "active") await del(`/v1/links/${link.id}`)
      else await patch(`/v1/links/${link.id}`, { status: "active" })
      links.reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "That did not work.")
    }
  }

  const rows = links.data?.data ?? []
  const total = links.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-heading text-xl font-semibold">Links</h1>
        {can.createLink(actor) ? (
          <NextLink href="/links/new/" className="ml-auto">
            <Button type="button">New link</Button>
          </NextLink>
        ) : null}
      </div>

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
          <Picker
            value={filters.domainId || ANY_DOMAIN}
            onChange={(value) => update({ domainId: value === ANY_DOMAIN ? "" : value })}
            options={[
              { value: ANY_DOMAIN, label: "All domains" },
              ...(domains.data?.data ?? []).map((domain) => ({
                value: domain.id,
                label: domain.host,
              })),
            ]}
          />
          <Picker
            value={filters.status}
            onChange={(value) => update({ status: value as Filters["status"] })}
            options={[
              { value: "active", label: "Active" },
              { value: "archived", label: "Archived" },
              { value: "all", label: "All" },
            ]}
          />
          <Picker
            value={filters.sort}
            onChange={(value) => update({ sort: value as Filters["sort"] })}
            options={[
              { value: "createdAt", label: "Newest first" },
              { value: "clicks", label: "Most clicks" },
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <QueryState
            loading={links.loading}
            error={links.error}
            empty={rows.length === 0}
            emptyMessage="No links match these filters."
          />

          {rows.length > 0 ? (
            <DataTable head={["Short URL", "Destination", "Tags", "Clicks", "Owner", "", ""]}>
              {rows.map((link) => (
                <TableRow
                  key={link.id}
                  className={link.status === "archived" ? "opacity-60" : undefined}
                >
                  <TableCell className="max-w-xs">
                    {/* min-w-0 so the link may shrink: without it the flex item
                        keeps its full text width and truncate never engages. */}
                    <div className="flex items-center gap-1">
                      <NextLink
                        href={`/links/detail/${qs({ id: link.id })}`}
                        className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
                      >
                        {link.domainHost}/{link.slug}
                      </NextLink>
                      <CopyButton value={link.shortUrl} />
                    </div>
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
                    {link.humanClicks}
                    <span className="text-muted-foreground"> + {link.botClicks} bot</span>
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate text-muted-foreground">
                    {link.ownerName}
                  </TableCell>
                  <TableCell>
                    {link.status === "archived" ? <Badge variant="outline">Archived</Badge> : null}
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
              ))}
            </DataTable>
          ) : null}

          {total > limit ? (
            <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
              <span>
                {offset + 1}–{Math.min(offset + limit, total)} of {total}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={offset + limit >= total}
                  onClick={() => setOffset(offset + limit)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
