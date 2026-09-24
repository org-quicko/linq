"use client"

import type { Condition, ConditionType, Platform, Rule } from "@linq/shared"
import { cn } from "cn"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { type ReactNode, useState } from "react"
import { Picker } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useRun } from "../lib/hooks"
import { useUpdateLinkRulesMutation } from "../lib/store/links"

/** A rule being edited. Position is implied by array order, as it is on the wire. */
export type RuleDraft = { destination: string; conditions: Condition[] }

export const CONDITION_OPTIONS: { value: ConditionType; label: string }[] = [
  { value: "platform", label: "Platform" },
  { value: "query_param", label: "Query param" },
]

export const PLATFORM_OPTIONS = [
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "desktop", label: "Desktop" },
]

/** A blank condition of the chosen type, so switching type never leaves stale fields. */
export function blankCondition(type: ConditionType): Condition {
  if (type === "platform") return { type: "platform", value: "android" }
  return { type: "query_param", key: "" }
}

/** The small blue "+ Add ..." affordance used inside the rules card. */
function AddLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex cursor-pointer items-center gap-1 py-1 text-[12.5px] font-medium text-chart-1 hover:opacity-70"
      onClick={onClick}
    >
      <PlusIcon className="size-3" />
      {children}
    </button>
  )
}

/**
 * Reusable list of rule drafts. Used both by the standalone RulesEditor on the
 * link detail page, and embedded directly inside LinkFormDialog.
 *
 * Each rule is its own box: a header (drag handle, name, remove, collapse),
 * then its "If" conditions and a "Then go to" destination. Only one rule is
 * open at a time. Reorder by dragging a rule by its handle, or focus the
 * handle and press the arrow keys.
 */
export function RulesList({
  rules,
  onChange,
  readOnly = false,
}: {
  rules: RuleDraft[]
  onChange: (next: RuleDraft[]) => void
  readOnly?: boolean
}) {
  // The one open rule, by position. Moves and removals keep it pointing at
  // the same rule.
  const [openIndex, setOpenIndex] = useState<number | null>(0)
  // The box is only draggable while its handle is held, so text in the
  // inputs stays selectable instead of starting a drag.
  const [grabbed, setGrabbed] = useState<number | null>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  /** Applies a change to one rule. */
  function edit(index: number, next: Partial<RuleDraft>) {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)))
  }

  /** Moves a rule to a new position; order here is the only thing that breaks a tie. */
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= rules.length) return
    const next = [...rules]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setOpenIndex((open) => {
      if (open === null) return null
      if (open === from) return to
      // The rules between `from` and `to` each shift one place toward `from`.
      if (from < open && open <= to) return open - 1
      if (to <= open && open < from) return open + 1
      return open
    })
    onChange(next)
  }

  function remove(index: number) {
    setOpenIndex((open) =>
      open === null || open === index ? null : open > index ? open - 1 : open,
    )
    onChange(rules.filter((_, i) => i !== index))
  }

  function endDrag() {
    setGrabbed(null)
    setDragging(null)
    setDragOver(null)
  }

  return (
    <div className="flex flex-col">
      {rules.length === 0 ? (
        <p className="py-2 text-center text-sm text-muted-foreground">
          No rules. Every visitor goes to the default destination.
        </p>
      ) : null}

      <div className="flex flex-col gap-2.5">
        {rules.map((rule, index) => {
          const expanded = openIndex === index
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drag source and drop target; the handle carries the keyboard path
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
              key={index}
              draggable={grabbed === index}
              className={cn(
                "rounded-lg border bg-background p-3 transition-opacity",
                dragging === index && "opacity-50",
                dragOver === index && dragging !== index && "border-chart-1 ring-1 ring-chart-1",
              )}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move"
                // Firefox refuses to start a drag without some data set.
                event.dataTransfer.setData("text/plain", String(index))
                setDragging(index)
              }}
              onDragEnd={endDrag}
              onDragOver={(event) => {
                if (dragging === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = "move"
                if (dragOver !== index) setDragOver(index)
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragging !== null) move(dragging, index)
                endDrag()
              }}
            >
              <div
                className={cn(
                  "flex items-center justify-between",
                  expanded && "mb-2.5 border-b pb-2.5",
                )}
              >
                <div className="flex items-center gap-2">
                  {readOnly ? null : (
                    // A span, not a <button>: Firefox never starts a drag from inside a button.
                    // biome-ignore lint/a11y/useSemanticElements: see above
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Reorder rule ${index + 1} (drag, or use the arrow keys)`}
                      className="flex cursor-grab items-center rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing"
                      onPointerDown={() => setGrabbed(index)}
                      onPointerUp={() => setGrabbed(null)}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowUp") move(index, index - 1)
                        else if (event.key === "ArrowDown") move(index, index + 1)
                        else return
                        event.preventDefault()
                      }}
                    >
                      <GripVerticalIcon className="size-3.5" />
                    </span>
                  )}
                  <span className="text-[13px] font-semibold">Rule {index + 1}</span>
                </div>
                <div className="flex items-center gap-1">
                  {readOnly ? null : (
                    <button
                      type="button"
                      aria-label={`Remove rule ${index + 1}`}
                      className="cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-destructive"
                      onClick={() => remove(index)}
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`${expanded ? "Collapse" : "Expand"} rule ${index + 1}`}
                    aria-expanded={expanded}
                    className="cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => setOpenIndex(expanded ? null : index)}
                  >
                    {expanded ? (
                      <ChevronUpIcon className="size-3" />
                    ) : (
                      <ChevronDownIcon className="size-3" />
                    )}
                  </button>
                </div>
              </div>

              {expanded ? (
                <div className="flex flex-col gap-2.5">
                  <span className="text-[12.5px] font-semibold">If</span>
                  {rule.conditions.map((condition, conditionIndex) => (
                    <ConditionRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional too
                      key={conditionIndex}
                      condition={condition}
                      readOnly={readOnly}
                      onChange={(next) =>
                        edit(index, {
                          conditions: rule.conditions.map((c, i) =>
                            i === conditionIndex ? next : c,
                          ),
                        })
                      }
                      onRemove={
                        rule.conditions.length > 1
                          ? () =>
                              edit(index, {
                                conditions: rule.conditions.filter((_, i) => i !== conditionIndex),
                              })
                          : undefined
                      }
                    />
                  ))}

                  {readOnly ? null : (
                    <div className="flex justify-end">
                      <AddLink
                        onClick={() =>
                          edit(index, {
                            conditions: [...rule.conditions, blankCondition("query_param")],
                          })
                        }
                      >
                        Add condition
                      </AddLink>
                    </div>
                  )}

                  <span className="mt-0.5 text-[12.5px] font-semibold">Then go to</span>
                  <Input
                    className="h-10"
                    value={rule.destination}
                    onChange={(event) => edit(index, { destination: event.target.value })}
                    placeholder="e.g. https://apps.apple.com/app/quicko"
                    disabled={readOnly}
                  />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {readOnly ? null : (
        <div className="mt-3">
          <AddLink
            onClick={() => {
              setOpenIndex(rules.length)
              onChange([...rules, { destination: "", conditions: [blankCondition("platform")] }])
            }}
          >
            Add rule
          </AddLink>
        </div>
      )}
    </div>
  )
}

/**
 * Edits the ordered rule list of one link.
 *
 * The whole list is sent as one PUT because that is the shape of the endpoint:
 * the server owns `position` and assigns it from array order, so reordering here
 * is just moving an item in the array.
 *
 * `readOnly` hides every control for someone who may not edit this link; the
 * server refuses the write in any case.
 */
export function RulesEditor({
  link_id,
  rules,
  readOnly,
}: {
  link_id: string
  rules: Rule[]
  readOnly: boolean
}) {
  const [drafts, setDrafts] = useState<RuleDraft[]>(() =>
    rules.map((rule) => ({ destination: rule.destination, conditions: rule.conditions })),
  )
  const [dirty, setDirty] = useState(false)
  const [updateRules] = useUpdateLinkRulesMutation()
  const { run, saving } = useRun()

  function save() {
    return run(() => updateRules({ link_id, rules: drafts }).unwrap(), {
      success: "Rules saved.",
      fallback: "Could not save the rules.",
      onSuccess: () => setDirty(false),
    })
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Rules</CardTitle>
        {readOnly ? null : (
          <CardAction className="flex gap-2">
            <Button type="button" onClick={save} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save rules"}
            </Button>
          </CardAction>
        )}
      </CardHeader>

      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          The first rule whose conditions all hold supplies the destination. No match falls back to
          the link&apos;s own destination.
        </p>

        <RulesList
          rules={drafts}
          readOnly={readOnly}
          onChange={(next) => {
            setDrafts(next)
            setDirty(true)
          }}
        />
      </CardContent>
    </Card>
  )
}

/** One condition: the field picker, "is", then whichever value that field needs. */
function ConditionRow({
  condition,
  readOnly,
  onChange,
  onRemove,
}: {
  condition: Condition
  readOnly: boolean
  onChange: (next: Condition) => void
  onRemove?: () => void
}) {
  const is = <span className="shrink-0 text-[13px] text-muted-foreground">is</span>

  return (
    <div className="flex items-center gap-2">
      <Picker
        className="w-[158px] shrink-0 data-[size=default]:h-[38px]"
        value={condition.type}
        disabled={readOnly}
        onChange={(value) => onChange(blankCondition(value as ConditionType))}
        options={CONDITION_OPTIONS}
      />

      {condition.type === "platform" ? (
        <>
          {is}
          <Picker
            className="min-w-0 flex-1 data-[size=default]:h-[38px]"
            value={condition.value}
            disabled={readOnly}
            onChange={(value) => onChange({ type: "platform", value: value as Platform })}
            options={PLATFORM_OPTIONS}
          />
        </>
      ) : null}

      {condition.type === "query_param" ? (
        <>
          <Input
            className="h-[38px] min-w-0 flex-1"
            value={condition.key}
            disabled={readOnly}
            placeholder="e.g. utm_source"
            onChange={(event) => onChange({ ...condition, key: event.target.value })}
          />
          {is}
          <Input
            className="h-[38px] min-w-0 flex-1"
            value={condition.value ?? ""}
            disabled={readOnly}
            placeholder="any value"
            onChange={(event) =>
              onChange({
                type: "query_param",
                key: condition.key,
                // An empty box means "present with any value", which is the
                // absent-value form the API expects.
                value: event.target.value || undefined,
              })
            }
          />
        </>
      ) : null}

      {onRemove && !readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label="Remove condition"
          onClick={onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      ) : null}
    </div>
  )
}
