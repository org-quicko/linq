"use client"

import type { Link } from "@linq/shared"
import { Picker, When } from "@/components/common"
import {
  Collection,
  PageHeader,
  ShortLink,
  shortLinkText,
  ThemeToggle,
} from "@/components/patterns"
import { Card, CardContent } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"

/**
 * A gallery of `components/patterns`, in every state, with a theme switch at
 * the top — the fastest way to review the component set, and the surface
 * `plans/Plan_27.md` Part A3 uses for its dark-mode audit: everything visible
 * in dark at once, instead of hunting page by page.
 *
 * Fixture data only. Deliberately outside `AppShell` and never calls a
 * live-data hook (`DomainPicker` included — its whole point is owning a
 * `useListDomainsQuery`, which on a browser with no server connected would
 * navigate this page straight to `/`, per `lib/api.ts`'s no-server
 * redirect). Its options-list shape is shown instead via the same `Picker`
 * it wraps.
 *
 * Pruned from both production exports — see `package.json`'s `build` and
 * `build:standalone` scripts — and deliberately not in
 * `apps/server/test/admin-static.test.ts`'s page list: a test asserting
 * this 200s would fail the bundled build once it is gone.
 *
 * Grows as `components/patterns` does; today it covers `PageHeader`,
 * `Collection`, `ShortLink`, `DomainPicker`'s shape, `ThemeToggle`, and the
 * relative-time mode `When` gained alongside them. `RowCard`, `IconButton`,
 * `EmptyState`, `StatCard` and `TabShell` land in later Plan 27 commits.
 */
export default function ComponentGalleryPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="font-heading text-xl font-semibold">Component gallery</h1>
          <p className="text-sm text-muted-foreground">components/patterns, dev only.</p>
        </div>
        <ThemeToggle />
      </div>

      <Section title="PageHeader">
        <div className="rounded-md border p-4">
          <PageHeader
            title="Short links"
            description="Every link, filtered the same way the API filters them."
            actions={<span className="text-sm text-muted-foreground">(actions slot)</span>}
          />
        </div>
      </Section>

      <Section
        title="ShortLink"
        description="The display text and the copy button now always agree."
      >
        <div className="flex flex-col gap-3 rounded-md border p-4">
          <ShortLink link={FIXTURE_LINKS[0]} href="#" />
          <ShortLink link={FIXTURE_LINKS[1]} copy={false} />
          <p className="text-sm text-muted-foreground">
            Dialog-title form: “Purge {shortLinkText(FIXTURE_LINKS[0])}?”
          </p>
        </div>
      </Section>

      <Section title="Collection — table variant">
        <Card>
          <CardContent>
            <Collection
              query={{ isLoading: false }}
              rows={FIXTURE_LINKS}
              head={["Short URL", "Destination", "Updated"]}
            >
              {(link) => (
                <TableRow key={link.id}>
                  <TableCell>
                    <ShortLink link={link} />
                  </TableCell>
                  <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                    {link.destination}
                  </TableCell>
                  <TableCell>
                    <When iso={link.updatedAt} relative />
                  </TableCell>
                </TableRow>
              )}
            </Collection>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="Collection — list variant"
        description="What a RowCard-shaped page uses instead."
      >
        <Collection query={{ isLoading: false }} rows={FIXTURE_LINKS} variant="list">
          {(link) => (
            <div key={link.id} className="flex items-center gap-3 rounded-lg border p-3">
              <ShortLink link={link} href="#" />
              <span className="ml-auto text-xs text-muted-foreground">
                <When iso={link.updatedAt} relative />
              </span>
            </div>
          )}
        </Collection>
      </Section>

      <Section title="Collection — empty state">
        <Card>
          <CardContent>
            <Collection
              query={{ isLoading: false }}
              rows={[]}
              emptyMessage="No links match these filters."
            >
              {() => null}
            </Collection>
          </CardContent>
        </Card>
      </Section>

      <Section title="Collection — loading state">
        <Card>
          <CardContent>
            <Collection
              query={{ isLoading: true }}
              rows={[]}
              head={["Short URL", "Destination", "Updated"]}
            >
              {() => null}
            </Collection>
          </CardContent>
        </Card>
      </Section>

      <Section title="Collection — error state">
        <Card>
          <CardContent>
            <Collection
              query={{ isLoading: false, error: { message: "Could not reach the server." } }}
              rows={[]}
            >
              {() => null}
            </Collection>
          </CardContent>
        </Card>
      </Section>

      <Section
        title="DomainPicker"
        description="The live component owns its own domain query; this is its visual shape via the same Picker it wraps."
      >
        <div className="rounded-md border p-4">
          <Picker
            className="w-48"
            value="__any__"
            onChange={() => {}}
            options={[
              { value: "__any__", label: "All domains" },
              { value: "d1", label: "go.example.com" },
              { value: "d2", label: "links.example.org" },
            ]}
          />
        </div>
      </Section>

      <Section title="When — relative">
        <div className="flex flex-col gap-1 rounded-md border p-4 text-sm">
          <span>
            Absolute: <When iso={FIXTURE_LINKS[0].updatedAt} />
          </span>
          <span>
            Relative: <When iso={FIXTURE_LINKS[0].updatedAt} relative />
          </span>
        </div>
      </Section>

      <Section title="ThemeToggle">
        <div className="rounded-md border p-4">
          <ThemeToggle />
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="font-heading text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}

const now = new Date()
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString()

const FIXTURE_LINKS: Link[] = [
  {
    id: "1",
    domainId: "d1",
    domainHost: "go.example.com",
    slug: "spring-sale",
    shortUrl: "https://go.example.com/spring-sale",
    destination: "https://example.com/campaigns/spring-sale-2026",
    name: "Spring sale",
    tags: ["campaign", "email"],
    forwardQuery: true,
    presetParams: {},
    status: "active",
    ownerId: "k1",
    ownerName: "ops",
    humanVisits: 482,
    botVisits: 12,
    expiresAt: null,
    listed: false,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(2),
  },
  {
    id: "2",
    domainId: "d2",
    domainHost: "links.example.org",
    slug: "beta",
    shortUrl: "https://links.example.org/beta",
    destination: "https://example.org/beta-signup",
    name: null,
    tags: [],
    forwardQuery: false,
    presetParams: {},
    status: "archived",
    ownerId: null,
    ownerName: null,
    humanVisits: 9,
    botVisits: 1,
    expiresAt: null,
    listed: false,
    createdAt: daysAgo(90),
    updatedAt: daysAgo(20),
  },
]
