"use client"

import {
  LINK_TREE_ACCENTS,
  LINK_TREE_DEFAULT_ACCENT,
  LINK_TREE_MAX_ITEMS,
  type Link,
  type LinkTree,
  type LinkTreeAppearance,
  type LinkTreeButtonStyle,
  type LinkTreeItemInput,
  type LinkTreePage,
  LinkTreeUtil,
} from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { cn } from "cn"
import { GripVertical, Link2, ListTree, Pencil, Plus, X } from "lucide-react"
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react"
import { Field } from "@/components/common"
import { ShortLinkField } from "@/components/link-form-dialog"
import { EmptyState, IconButton, LinkFilter } from "@/components/patterns"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { withScheme } from "../lib/api"
import { useRun } from "../lib/hooks"
import { randomSlug } from "../lib/slug"
import { useListDomainsQuery } from "../lib/store/domains"
import {
  useCreateLinkTreeMutation,
  useGetLinkTreeQuery,
  useUpdateLinkTreeMutation,
} from "../lib/store/link-trees"

/** One Item while it is being edited: an existing Link, or a URL that becomes one on save. */
type ItemDraft = {
  key: string
  label: string
  target:
    | { kind: "link"; id: string; name: string; short_url: string; domain_id: string }
    | { kind: "url"; url: string }
}

type Draft = {
  domain_id: string
  slug: string
  name: string
  description: string
  image_url: string
  appearance: LinkTreeAppearance
  accent: string
  button_style: LinkTreeButtonStyle
  tags: string[]
  items: ItemDraft[]
}

const APPEARANCES: { value: LinkTreeAppearance; label: string }[] = [
  { value: "auto", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
]

const BUTTON_STYLES: { value: LinkTreeButtonStyle; label: string }[] = [
  { value: "filled", label: "Filled" },
  { value: "outline", label: "Outline" },
  { value: "soft", label: "Soft" },
]

const HEX = /^#[0-9a-fA-F]{6}$/

/**
 * Create, Edit and Duplicate for a Link Tree, in one dialog — the same shape
 * as `LinkFormDialog`. `link` is the tree being edited (`mode` `"edit"`) or
 * the one being duplicated (`mode` `"create"`); either way its page is loaded
 * first, since the list row carries only the Link.
 */
export function LinkTreeFormDialog({
  open,
  onOpenChange,
  mode,
  link,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  link?: Link
}) {
  const tree = useGetLinkTreeQuery(link?.id ?? skipToken)

  if (link && !tree.data) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[960px]">
          <DialogHeader>
            <DialogTitle>
              {mode === "create" ? "Duplicate link tree" : "Edit link tree"}
            </DialogTitle>
            <DialogDescription className="sr-only">Loading the link tree.</DialogDescription>
          </DialogHeader>
          {tree.isError ? (
            <p className="text-sm text-destructive">Could not load this link tree.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  return <LinkTreeForm open={open} onOpenChange={onOpenChange} mode={mode} tree={tree.data} />
}

function LinkTreeForm({
  open,
  onOpenChange,
  mode,
  tree,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  tree?: LinkTree
}) {
  const domains = useListDomainsQuery({ limit: 200 })
  const activeDomains = (domains.data?.data ?? []).filter((domain) => domain.status === "active")
  const [createLinkTree] = useCreateLinkTreeMutation()
  const [updateLinkTree] = useUpdateLinkTreeMutation()
  const { run, saving } = useRun()

  const initial = useMemo(() => draftFrom(tree, mode), [tree, mode])
  const [draft, setDraft] = useState<Draft>(initial)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [lastAdded, setLastAdded] = useState<string | null>(null)
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const domainId =
    mode === "create" ? draft.domain_id || activeDomains[0]?.id || "" : tree?.domain_id
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const accentValid = HEX.test(draft.accent)
  const full = draft.items.length >= LINK_TREE_MAX_ITEMS

  function requestClose() {
    if (dirty && !saving) setConfirmDiscard(true)
    else onOpenChange(false)
  }

  function changeDomain(id: string) {
    // An Item must live on the tree's own Domain, so Links picked on the old one go.
    setDraft((current) => ({
      ...current,
      domain_id: id,
      items: current.items.filter(
        (item) => item.target.kind === "url" || item.target.domain_id === id,
      ),
    }))
  }

  function submit() {
    const items = draft.items.map(itemInput)
    const page = {
      name: draft.name.trim(),
      appearance: draft.appearance,
      accent: draft.accent.toLowerCase(),
      button_style: draft.button_style,
      tags: draft.tags,
      items,
    }
    const image_url = draft.image_url.trim() ? withScheme(draft.image_url.trim()) : null

    if (mode === "create") {
      return run(
        () =>
          createLinkTree({
            ...page,
            domain_id: domainId as string,
            slug: draft.slug.trim().replace(/^\/+|\/+$/g, "") || undefined,
            description: draft.description.trim() || undefined,
            image_url,
          }).unwrap(),
        {
          success: "Link tree created.",
          fallback: "Could not create the link tree.",
          onSuccess: () => onOpenChange(false),
        },
      )
    }
    return run(
      () =>
        updateLinkTree({
          id: (tree as LinkTree).id,
          body: { ...page, description: draft.description.trim() || null, image_url },
        }).unwrap(),
      { success: "Saved.", fallback: "Could not save.", onSuccess: () => onOpenChange(false) },
    )
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[960px]">
          <div className="grid md:grid-cols-[minmax(0,1fr)_360px]">
            <div className="flex min-w-0 flex-col gap-4 p-5">
              <DialogHeader>
                <DialogTitle>
                  {mode === "create" ? "Create link tree" : "Edit link tree"}
                </DialogTitle>
                <DialogDescription>
                  One short link that opens a page listing your other links.
                </DialogDescription>
              </DialogHeader>

              {/* -m-1/p-1, as in LinkFormDialog: room for focus rings at the scroll edge. */}
              <div className="no-scrollbar -m-1 flex max-h-[68vh] flex-col gap-6 overflow-y-auto p-1">
                <Section title="Page">
                  <Field label="Title">
                    <Input
                      value={draft.name}
                      onChange={(event) => set("name", event.target.value)}
                      placeholder="Ada Lovelace"
                      maxLength={200}
                    />
                  </Field>
                  <Field
                    label="Short link"
                    hint={
                      mode === "edit"
                        ? "Short links can't be changed after creation — existing copies would stop working."
                        : undefined
                    }
                  >
                    <ShortLinkField
                      mode={mode}
                      domain_host={tree?.domain_host}
                      domain_id={domainId ?? ""}
                      domains={activeDomains}
                      onDomainChange={changeDomain}
                      slug={draft.slug}
                      onSlugChange={(slug) => set("slug", slug)}
                    />
                  </Field>
                  <Field label="Description">
                    <Textarea
                      value={draft.description}
                      onChange={(event) => set("description", event.target.value)}
                      placeholder="A line or two about you"
                      maxLength={500}
                      rows={2}
                      className="min-h-0 resize-none"
                    />
                  </Field>
                  <Field
                    label="Image URL"
                    hint="Shown as a round avatar. Leave empty for an initial."
                  >
                    <Input
                      value={draft.image_url}
                      onChange={(event) => set("image_url", event.target.value)}
                      placeholder="example.com/avatar.png"
                    />
                  </Field>
                  <Field label="Tags">
                    <TagPicker
                      value={draft.tags}
                      onChange={(tags) => set("tags", tags)}
                      creatable
                      placeholder="No tags"
                    />
                  </Field>
                </Section>

                <Section title="Appearance">
                  <Row label="Theme">
                    <Segmented
                      label="Theme"
                      value={draft.appearance}
                      options={APPEARANCES}
                      onChange={(appearance) => set("appearance", appearance)}
                    />
                  </Row>
                  <Row label="Buttons">
                    <Segmented
                      label="Button style"
                      value={draft.button_style}
                      options={BUTTON_STYLES}
                      onChange={(style) => set("button_style", style)}
                    />
                  </Row>
                  <Row label="Accent">
                    <AccentPicker
                      value={draft.accent}
                      onChange={(accent) => set("accent", accent)}
                    />
                  </Row>
                  <AccentHint accent={draft.accent} style={draft.button_style} />
                </Section>

                <Section
                  title="Items"
                  aside={
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {draft.items.length}/{LINK_TREE_MAX_ITEMS}
                    </span>
                  }
                >
                  <ItemsEditor
                    items={draft.items}
                    onChange={(items) => set("items", items)}
                    focusKey={lastAdded}
                  />
                  <AddItem
                    domainId={domainId ?? ""}
                    disabled={full}
                    onAdd={(item) => {
                      set("items", [...draft.items, item])
                      setLastAdded(item.key)
                    }}
                  />
                </Section>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={requestClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={saving || !draft.name.trim() || !accentValid || !domainId}
                  onClick={submit}
                >
                  {mode === "create" ? "Create link tree" : "Save changes"}
                </Button>
              </DialogFooter>
            </div>

            <aside className="hidden flex-col gap-3 border-l bg-muted/60 p-5 md:flex">
              <span className="text-xs font-medium text-muted-foreground">Preview</span>
              <PhonePreview page={previewPage(draft)} />
            </aside>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard your changes?</DialogTitle>
            <DialogDescription>
              {mode === "create"
                ? "This link tree hasn't been created yet."
                : "Your edits to this link tree haven't been saved."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false)
                onOpenChange(false)
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A label on the left and its control on the right — the Appearance rows. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** A small radio group drawn as a segmented control. Arrow keys move the choice, as in any radio group. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map((option, i) => {
        const checked = option.value === value
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled segmented control; role, aria-checked, roving tabindex and arrow keys give it native radio semantics
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              const step =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 0
              if (!step) return
              event.preventDefault()
              const next = (i + step + options.length) % options.length
              onChange(options[next].value)
              refs.current[next]?.focus()
            }}
            className={cn(
              "h-7 cursor-pointer rounded-md px-3 text-[12.5px] transition-[background-color,color,box-shadow,transform] duration-150 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] motion-reduce:active:scale-100",
              checked
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const SWATCH =
  "size-6 cursor-pointer rounded-full ring-offset-2 ring-offset-background transition-[transform,box-shadow] duration-150 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.92] motion-reduce:active:scale-100"

/**
 * The curated accents as swatches, then one more swatch that opens the
 * system colour picker. A picker always yields a valid colour, so there is no
 * hex to mistype. Once a custom colour is chosen, that swatch shows it.
 */
function AccentPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const current = value.toLowerCase()
  const custom = !(LINK_TREE_ACCENTS as readonly string[]).includes(current)
  return (
    <div role="radiogroup" aria-label="Accent colour" className="flex items-center gap-1.5">
      {LINK_TREE_ACCENTS.map((accent) => {
        const checked = accent === current
        return (
          // biome-ignore lint/a11y/useSemanticElements: colour swatches drawn as buttons, announced as radios with aria-checked
          <button
            key={accent}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={accent}
            onClick={() => onChange(accent)}
            className={cn(SWATCH, checked && "ring-2 ring-foreground")}
            style={{ background: accent }}
          />
        )
      })}
      {/* The native input sits invisibly over the swatch, so a click on the
          swatch is a click on the input and opens the system picker. */}
      <label
        className={cn(
          SWATCH,
          "relative overflow-hidden focus-within:ring-[3px] focus-within:ring-ring/50",
          custom && "ring-2 ring-foreground",
        )}
        style={{
          background: custom
            ? current
            : "conic-gradient(from 0deg, #ef4444, #f59e0b, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)",
        }}
        title="Custom colour"
      >
        <input
          type="color"
          aria-label="Custom accent colour"
          value={HEX.test(current) ? current : LINK_TREE_DEFAULT_ACCENT}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}

/** Warns before saving an accent the page can't put readable text on. */
function AccentHint({ accent, style }: { accent: string; style: LinkTreeButtonStyle }) {
  if (!HEX.test(accent) || style !== "filled") return null
  const ratio = LinkTreeUtil.contrastRatio(accent, LinkTreeUtil.contrastText(accent))
  if (ratio >= 4.5) return null
  return (
    <p className="text-xs text-muted-foreground">
      Button text is hard to read on this colour ({ratio.toFixed(1)}:1). A darker or lighter shade
      will read better.
    </p>
  )
}

/**
 * The ordered Items. Each row drags by its handle, and the handle also moves
 * the row with the arrow keys, so reordering never needs a pointer. No
 * reorder animation: it repeats many times in one edit.
 */
function ItemsEditor({
  items,
  onChange,
  focusKey,
}: {
  items: ItemDraft[]
  onChange: (items: ItemDraft[]) => void
  /** The Item just added: its title field takes focus, so naming it is the next keystroke. */
  focusKey: string | null
}) {
  const [armed, setArmed] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const titles = useRef(new Map<string, HTMLInputElement>())

  useEffect(() => {
    if (focusKey) titles.current.get(focusKey)?.focus()
  }, [focusKey])

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed">
        <EmptyState
          icon={ListTree}
          message="No items yet. Add a short link or paste a URL below."
        />
      </div>
    )
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length || from === to) return
    const next = [...items]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    onChange(next)
  }

  return (
    <ol className="flex flex-col gap-2">
      {items.map((item, i) => (
        <li
          key={item.key}
          draggable={armed === item.key}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "move"
            setDragging(item.key)
          }}
          onDragOver={(event) => {
            if (!dragging || dragging === item.key) return
            event.preventDefault()
            move(
              items.findIndex((other) => other.key === dragging),
              i,
            )
          }}
          onDragEnd={() => {
            setDragging(null)
            setArmed(null)
          }}
          className={cn(
            "flex items-center gap-2 rounded-lg border bg-card py-1.5 pr-1.5 pl-1 transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none",
            dragging === item.key && "opacity-50",
          )}
        >
          <button
            type="button"
            ref={(el) => {
              if (el) handles.current.set(item.key, el)
              else handles.current.delete(item.key)
            }}
            aria-label={`Reorder ${item.label || targetName(item)}. Use the arrow keys to move it.`}
            onPointerDown={() => setArmed(item.key)}
            onPointerUp={() => setArmed(null)}
            onKeyDown={(event) => {
              const to = event.key === "ArrowUp" ? i - 1 : event.key === "ArrowDown" ? i + 1 : null
              if (to === null) return
              event.preventDefault()
              move(i, to)
              requestAnimationFrame(() => handles.current.get(item.key)?.focus())
            }}
            className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            <GripVertical className="size-3.5" />
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Reads as a field: a border on hover and focus, a pencil cue,
                and a muted placeholder naming the title used when it's empty. */}
            <div className="group/title relative">
              <input
                ref={(el) => {
                  if (el) titles.current.set(item.key, el)
                  else titles.current.delete(item.key)
                }}
                aria-label={`Title for ${targetName(item)}`}
                value={item.label}
                placeholder={`Title (default: ${targetName(item)})`}
                maxLength={100}
                onChange={(event) =>
                  onChange(
                    items.map((other) =>
                      other.key === item.key ? { ...other, label: event.target.value } : other,
                    ),
                  )
                }
                className="-ml-1.5 h-7 w-[calc(100%+0.375rem)] min-w-0 rounded-md border border-transparent bg-transparent pr-7 pl-1.5 text-sm font-medium outline-none transition-[border-color,box-shadow] duration-150 placeholder:font-normal placeholder:text-muted-foreground hover:border-input focus:border-ring focus:ring-3 focus:ring-ring/50"
              />
              <Pencil
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/title:opacity-0 group-hover/title:opacity-100"
              />
            </div>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {item.target.kind === "link" ? (
                <>
                  <Link2 className="size-3 shrink-0" />
                  <span className="truncate">
                    {item.target.short_url.replace(/^https?:\/\//, "")}
                  </span>
                </>
              ) : (
                <>
                  <Plus className="size-3 shrink-0" />
                  <span className="truncate">New short link to {item.target.url}</span>
                </>
              )}
            </span>
          </div>
          <IconButton
            icon={X}
            label={`Remove ${item.label || targetName(item)}`}
            onClick={() => onChange(items.filter((other) => other.key !== item.key))}
          />
        </li>
      ))}
    </ol>
  )
}

/** Adds an Item: pick an existing short link on the tree's Domain, or paste a URL. */
function AddItem({
  domainId,
  disabled,
  onAdd,
}: {
  domainId: string
  disabled: boolean
  onAdd: (item: ItemDraft) => void
}) {
  const [url, setUrl] = useState("")
  const urlId = useId()

  function addUrl(event: FormEvent) {
    event.preventDefault()
    const value = url.trim()
    if (!value) return
    onAdd({ key: crypto.randomUUID(), label: "", target: { kind: "url", url: withScheme(value) } })
    setUrl("")
  }

  if (disabled) {
    return (
      <p className="text-xs text-muted-foreground">
        A link tree holds at most {LINK_TREE_MAX_ITEMS} items.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <LinkFilter
        value=""
        name=""
        type="redirect"
        status="active"
        domainId={domainId || undefined}
        placeholder="Add a short link"
        className="relative min-w-0 flex-1"
        fieldClassName="w-full"
        onSelect={(id, name, link) =>
          onAdd({
            key: crypto.randomUUID(),
            label: "",
            target: {
              kind: "link",
              id,
              name,
              short_url: link.short_url,
              domain_id: link.domain_id,
            },
          })
        }
      />
      <form onSubmit={addUrl} className="flex min-w-0 flex-1 gap-2">
        <label htmlFor={urlId} className="sr-only">
          Or paste a URL
        </label>
        <Input
          id={urlId}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="or paste a URL"
          className="h-9 min-w-0"
        />
        <Button type="submit" variant="outline" disabled={!url.trim()}>
          Add
        </Button>
      </form>
    </div>
  )
}

/**
 * The page exactly as visitors will get it: the shared renderer's HTML in a
 * sandboxed frame. The sandbox allows neither scripts nor popups, and the
 * injected `<base target="_blank">` turns every Item click into a blocked
 * popup, so the preview stays put while still scrolling and showing hover.
 */
function PhonePreview({ page }: { page: LinkTreePage }) {
  const html = LinkTreeUtil.renderPage(page).replace("<head>", '<head><base target="_blank">')
  return (
    <div className="mx-auto w-[300px] overflow-hidden rounded-[28px] border-[6px] border-foreground/90 bg-background shadow-panel">
      <iframe
        title="Link tree preview"
        srcDoc={html}
        sandbox=""
        className="block h-[560px] w-full"
      />
    </div>
  )
}

function draftFrom(tree: LinkTree | undefined, mode: "create" | "edit"): Draft {
  return {
    domain_id: tree?.domain_id ?? "",
    slug: mode === "edit" ? (tree?.slug ?? "") : randomSlug(),
    name: tree ? (mode === "create" ? `${tree.name ?? ""} copy`.trim() : (tree.name ?? "")) : "",
    description: tree?.description ?? "",
    image_url: tree?.tree.image_url ?? "",
    appearance: tree?.tree.appearance ?? "auto",
    accent: tree?.tree.accent ?? LINK_TREE_DEFAULT_ACCENT,
    button_style: tree?.tree.button_style ?? "filled",
    tags: tree?.tags ?? [],
    items: (tree?.tree.items ?? [])
      .filter((item) => item.link.status === "active")
      .map((item) => ({
        key: item.id,
        // The stored title, always: a saved Item shows what visitors see, not a placeholder.
        label: item.label,
        target: {
          kind: "link" as const,
          id: item.link.id,
          name: item.link.name ?? item.link.slug,
          short_url: item.link.short_url,
          domain_id: tree?.domain_id ?? "",
        },
      })),
  }
}

/** What an Item shows when its label is left empty, as the server will name it. */
function targetName(item: ItemDraft): string {
  if (item.target.kind === "link") return item.target.name
  try {
    return new URL(item.target.url).host
  } catch {
    return item.target.url
  }
}

function itemInput(item: ItemDraft): LinkTreeItemInput {
  const label = item.label.trim() || undefined
  return item.target.kind === "link"
    ? { link_id: item.target.id, label }
    : { url: item.target.url, label }
}

function previewPage(draft: Draft): LinkTreePage {
  return {
    title: draft.name.trim() || "Untitled",
    description: draft.description.trim() || null,
    image_url: draft.image_url.trim() ? withScheme(draft.image_url.trim()) : null,
    appearance: draft.appearance,
    accent: HEX.test(draft.accent) ? draft.accent : LINK_TREE_DEFAULT_ACCENT,
    button_style: draft.button_style,
    items: draft.items.map((item) => ({
      label: item.label.trim() || targetName(item),
      url: item.target.kind === "link" ? item.target.short_url : item.target.url,
    })),
  }
}
