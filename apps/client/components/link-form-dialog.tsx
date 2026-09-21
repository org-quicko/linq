"use client"

import { type Actor, can, type Domain, type Link } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { CalendarIcon, ChevronDown, Info, Route, TagIcon } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Field, Picker } from "@/components/common"
import {
  type PresetParamRow,
  PresetParamsEditor,
  presetParamsToRows,
  rowsToPresetParams,
} from "@/components/preset-params-editor"
import { blankCondition, type RuleDraft, RulesList } from "@/components/rules-editor"
import { TagPicker } from "@/components/tag-picker"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
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
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { fromDatetimeLocal, toDatetimeLocal, withScheme } from "../lib/api"
import { useRun } from "../lib/hooks"
import { useListDomainsQuery } from "../lib/store/domains"
import { useListKeysQuery } from "../lib/store/keys"
import {
  useCreateLinkMutation,
  useGetLinkRulesQuery,
  useUpdateLinkMutation,
} from "../lib/store/links"

/**
 * The one form behind Create, Edit and Duplicate — extracted from
 * `app/links/new/page.tsx` and the settings half of `app/links/detail/page.tsx`
 * (plans/Plan_27.md Part C4). `mode` decides the verb and what gets sent;
 * `link` seeds the fields either way — as the record being edited (`mode`
 * `"edit"`, slug and domain locked) or as the starting point for a duplicate
 * (`mode` `"create"`, slug blank so the server generates a fresh one).
 *
 * Rules are configured in the collapsible "Routing rules" section (plans/Plan_28.md):
 * passed directly on create or patch.
 */
export function LinkFormDialog({
  open,
  onOpenChange,
  actor,
  mode,
  link,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  actor: Actor
  mode: "create" | "edit"
  link?: Link
}) {
  const domains = useListDomainsQuery({ limit: 200 })
  const keys = useListKeysQuery({ limit: 200 })
  const [createLink] = useCreateLinkMutation()
  const [updateLink] = useUpdateLinkMutation()
  const { run, saving } = useRun()

  const activeDomains = (domains.data?.data ?? []).filter((domain) => domain.status === "active")
  const canTransfer = mode === "edit" && !!link && can.transferLink(actor, link)

  const [domain_id, setDomainId] = useState(link?.domain_id ?? "")
  const [slug, setSlug] = useState(mode === "edit" ? (link?.slug ?? "") : "")
  const [destination, setDestination] = useState(link?.destination ?? "")
  const [name, setName] = useState(link?.name ?? "")
  const [description, setDescription] = useState(link?.description ?? "")
  const [tags, setTags] = useState<string[]>(link?.tags ?? [])
  const [owner_id, setOwnerId] = useState(link?.owner_id ?? "")
  const [forward_query, setForwardQuery] = useState(link?.forward_query ?? true)
  const [listed, setListed] = useState(link?.listed ?? false)
  const [preset_params, setPresetParams] = useState<PresetParamRow[]>(() =>
    link ? presetParamsToRows(link.preset_params) : [],
  )
  const [paramsOpen, setParamsOpen] = useState(!!link && Object.keys(link.preset_params).length > 0)
  const [expires_at, setExpiresAt] = useState(() => toDatetimeLocal(link?.expires_at ?? null))
  const [expiryOpen, setExpiryOpen] = useState(!!link?.expires_at)

  const { data: existingRules } = useGetLinkRulesQuery(link?.id ?? skipToken)
  const [rulesDrafts, setRulesDrafts] = useState<RuleDraft[]>([])
  const [rulesDirty, setRulesDirty] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)

  useEffect(() => {
    if (existingRules && existingRules.length > 0 && !rulesDirty) {
      setRulesDrafts(
        existingRules.map((r) => ({ destination: r.destination, conditions: r.conditions })),
      )
      setRulesOpen(true)
    }
  }, [existingRules, rulesDirty])

  const chosenDomain = mode === "create" ? domain_id || activeDomains[0]?.id || "" : link?.domain_id

  function submit() {
    const validRules = rulesOpen
      ? rulesDrafts
          .map((r) => ({ ...r, destination: withScheme(r.destination) }))
          .filter((r) => r.destination.length > 0)
      : []

    const shared = {
      destination: withScheme(destination),
      tags,
      forward_query,
      preset_params: rowsToPresetParams(preset_params),
      expires_at: expiryOpen ? fromDatetimeLocal(expires_at) : null,
      listed,
    }

    if (mode === "create") {
      return run(
        () =>
          createLink({
            ...shared,
            domain_id: chosenDomain as string,
            slug: slug.trim() || undefined,
            name: name.trim() || undefined,
            description: description.trim() || undefined,
            rules: validRules,
          }).unwrap(),
        {
          success: "Link created.",
          fallback: "Could not create the link.",
          onSuccess: () => onOpenChange(false),
        },
      )
    }

    // mode "edit" always carries a link
    const current = link as Link
    return run(
      () =>
        updateLink({
          id: current.id,
          body: {
            ...shared,
            name: name.trim() || null,
            description: description.trim() || null,
            ...(owner_id !== current.owner_id ? { owner_id } : {}),
            ...(rulesDirty ? { rules: validRules } : {}),
          },
        }).unwrap(),
      { success: "Saved.", fallback: "Could not save.", onSuccess: () => onOpenChange(false) },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create link" : "Edit link"}</DialogTitle>
        </DialogHeader>

        {/* -m-1/p-1 cancel out visually (fields stay aligned with the header
            and footer) but give the scroll container's clipping box enough
            room that a focused field's ring isn't cut off at its edge. */}
        <div className="no-scrollbar -m-1 flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-1">
          <Field label="Destination URL">
            <Input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="example.com/landing"
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
              domain_host={link?.domain_host}
              domain_id={chosenDomain ?? ""}
              domains={activeDomains}
              onDomainChange={setDomainId}
              slug={slug}
              onSlugChange={setSlug}
            />
          </Field>

          <Field label="Title">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>

          <Field label="Description">
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>

          <Field label="Tags">
            <TagPicker value={tags} onChange={setTags} creatable placeholder="No tags" />
          </Field>

          {mode === "edit" ? (
            <Field
              label="Owner"
              hint={
                canTransfer
                  ? "Handing this to another key gives up your own access unless your role covers it."
                  : "Only an admin, or the owning key, may hand a link over."
              }
            >
              <Picker
                value={owner_id}
                disabled={!canTransfer}
                onChange={setOwnerId}
                options={(keys.data?.data ?? [])
                  // The server refuses a viewer as an owner; the current owner
                  // still renders even if a demotion since made it one.
                  .filter((key) => can.ownLink(key) || key.id === link?.owner_id)
                  .map((key) => ({ value: key.id, label: key.name }))}
              />
            </Field>
          ) : null}

          <div className="flex items-center gap-1.5">
            <Label className="font-normal">
              <Checkbox
                checked={listed}
                onCheckedChange={(checked) => setListed(checked === true)}
              />
              List in /llms.txt
            </Label>
            <InfoTip>
              Publishes this link's name and destination in /llms.txt, readable without a key.
            </InfoTip>
          </div>

          <div className="flex items-center gap-1.5">
            <Label className="font-normal">
              <Checkbox
                checked={forward_query}
                onCheckedChange={(checked) => setForwardQuery(checked === true)}
              />
              Forward query params on redirect
            </Label>
            <InfoTip>
              When this short URL is visited, any query params appended to it are forwarded to the
              destination.
            </InfoTip>
          </div>

          <ToggleSection
            icon={<TagIcon className="size-3.5" />}
            label="Query Parameters"
            open={paramsOpen}
            onOpenChange={setParamsOpen}
          >
            <PresetParamsEditor
              rows={preset_params}
              onChange={setPresetParams}
              readOnly={false}
              forward_query={forward_query}
            />
          </ToggleSection>

          <ToggleSection
            icon={<CalendarIcon className="size-3.5" />}
            label="Expiry date"
            open={expiryOpen}
            onOpenChange={setExpiryOpen}
          >
            <Input
              type="datetime-local"
              value={expires_at}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </ToggleSection>

          <ToggleSection
            icon={<Route className="size-3.5" />}
            label="Rules"
            open={rulesOpen}
            onOpenChange={(next) => {
              setRulesOpen(next)
              if (next && rulesDrafts.length === 0) {
                setRulesDrafts([{ destination: "", conditions: [blankCondition("platform")] }])
                setRulesDirty(true)
              }
            }}
          >
            <RulesList
              rules={rulesDrafts}
              onChange={(next) => {
                setRulesDrafts(next)
                setRulesDirty(true)
              }}
            />
          </ToggleSection>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || !destination.trim()} onClick={submit}>
            {mode === "create" ? "Create link" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The mockup's small "i" glyph next to a checkbox whose label alone doesn't
 *  carry the full explanation — hover for the detail, instead of running the
 *  whole sentence into the checkbox's own label. */
function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex text-muted-foreground">
          <Info className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{children}</TooltipContent>
    </Tooltip>
  )
}

/** A labelled switch that reveals its content only once turned on — the
 *  mockup's pattern for Query Parameters and Expiry date, both of which are
 *  the exception rather than the rule for most links. */
function ToggleSection({
  icon,
  label,
  open,
  onOpenChange,
  children,
}: {
  icon: ReactNode
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <div className="rounded-lg border">
      <Label className="flex items-center justify-between gap-2 p-3 font-normal">
        <span className="flex items-center gap-2 text-muted-foreground">
          {icon}
          {label}
        </span>
        <Switch checked={open} onCheckedChange={onOpenChange} />
      </Label>
      {open ? <div className="border-t p-3">{children}</div> : null}
    </div>
  )
}

/**
 * The domain and the slug as one control — the mockup's "Short Link" field,
 * a domain pill attached to the slug input rather than two side-by-side
 * dropdown/input pairs. The domain is only pickable in `mode: "create"`; an
 * existing link's domain is locked the same way its slug already is.
 */
function ShortLinkField({
  mode,
  domain_host,
  domain_id,
  domains,
  onDomainChange,
  slug,
  onSlugChange,
}: {
  mode: "create" | "edit"
  domain_host?: string
  domain_id: string
  domains: Domain[]
  onDomainChange: (id: string) => void
  slug: string
  onSlugChange: (slug: string) => void
}) {
  const currentHost =
    mode === "create" ? domains.find((d) => d.id === domain_id)?.host : domain_host

  return (
    <div className="flex h-9 items-stretch overflow-hidden rounded-lg border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
      {mode === "create" ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 border-r bg-muted/40 px-2.5 text-sm hover:bg-muted"
            >
              <span className="max-w-36 truncate">{currentHost ?? "No domain"}</span>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {domains.map((domain) => (
              <DropdownMenuItem key={domain.id} onSelect={() => onDomainChange(domain.id)}>
                {domain.host}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <span className="flex shrink-0 items-center border-r bg-muted/40 px-2.5 text-sm text-muted-foreground">
          {currentHost}
        </span>
      )}
      <input
        className="min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        value={slug}
        onChange={(event) => onSlugChange(event.target.value)}
        placeholder="spring-sale"
        spellCheck={false}
        disabled={mode === "edit"}
        readOnly={mode === "edit"}
      />
    </div>
  )
}
