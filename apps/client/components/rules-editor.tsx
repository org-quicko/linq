"use client"

import type { Condition, ConditionType, Platform, Rule } from "@linq/shared"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Picker } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { put } from "../lib/api"

/** A rule being edited. Position is implied by array order, as it is on the wire. */
type Draft = { destination: string; conditions: Condition[] }

const CONDITION_OPTIONS: { value: ConditionType; label: string }[] = [
  { value: "platform", label: "Platform is" },
  { value: "query_param", label: "Query parameter" },
  { value: "country", label: "Country is" },
]

const PLATFORM_OPTIONS = [
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "desktop", label: "Desktop" },
]

/** A blank condition of the chosen type, so switching type never leaves stale fields. */
function blankCondition(type: ConditionType): Condition {
  if (type === "platform") return { type: "platform", value: "android" }
  if (type === "country") return { type: "country", value: "IN" }
  return { type: "query_param", key: "" }
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
  linkId,
  rules,
  readOnly,
  onSaved,
}: {
  linkId: string
  rules: Rule[]
  readOnly: boolean
  onSaved: () => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    rules.map((rule) => ({ destination: rule.destination, conditions: rule.conditions })),
  )
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  /** Applies a change to one rule and marks the list unsaved. */
  function edit(index: number, next: Partial<Draft>) {
    setDrafts((current) => current.map((rule, i) => (i === index ? { ...rule, ...next } : rule)))
    setDirty(true)
  }

  /** Moves a rule up or down; order here is the only thing that breaks a tie. */
  function move(index: number, by: -1 | 1) {
    const target = index + by
    if (target < 0 || target >= drafts.length) return
    setDrafts((current) => {
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setDirty(true)
  }

  async function save() {
    setSaving(true)
    try {
      await put(`/v1/links/${linkId}/rules`, drafts)
      setDirty(false)
      toast.success("Rules saved.")
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the rules.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Rules</CardTitle>
        {readOnly ? null : (
          <CardAction className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDrafts([
                  ...drafts,
                  { destination: "", conditions: [blankCondition("platform")] },
                ])
                setDirty(true)
              }}
            >
              Add rule
            </Button>
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

        {drafts.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No rules. Every visitor goes to the default destination.
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          {drafts.map((rule, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
            <div key={index} className="rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">#{index + 1}</Badge>
                <Input
                  value={rule.destination}
                  onChange={(event) => edit(index, { destination: event.target.value })}
                  placeholder="https://play.google.com/store/apps/…"
                  disabled={readOnly}
                />
                {readOnly ? null : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Move up"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                    >
                      <ArrowUpIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Move down"
                      onClick={() => move(index, 1)}
                      disabled={index === drafts.length - 1}
                    >
                      <ArrowDownIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        setDrafts(drafts.filter((_, i) => i !== index))
                        setDirty(true)
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>

              <div className="mt-3 flex flex-col gap-2 pl-2">
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
                  <Button
                    type="button"
                    variant="ghost"
                    className="self-start"
                    onClick={() =>
                      edit(index, {
                        conditions: [...rule.conditions, blankCondition("query_param")],
                      })
                    }
                  >
                    + Add condition (all must hold)
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/** One condition: the type picker plus whichever fields that type needs. */
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
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Picker
        className="w-44"
        value={condition.type}
        disabled={readOnly}
        onChange={(value) => onChange(blankCondition(value as ConditionType))}
        options={CONDITION_OPTIONS}
      />

      {condition.type === "platform" ? (
        <Picker
          className="w-40"
          value={condition.value}
          disabled={readOnly}
          onChange={(value) => onChange({ type: "platform", value: value as Platform })}
          options={PLATFORM_OPTIONS}
        />
      ) : null}

      {condition.type === "country" ? (
        <Input
          className="w-24"
          value={condition.value}
          disabled={readOnly}
          maxLength={2}
          placeholder="IN"
          onChange={(event) => onChange({ type: "country", value: event.target.value })}
        />
      ) : null}

      {condition.type === "query_param" ? (
        <>
          <Input
            className="w-40"
            value={condition.key}
            disabled={readOnly}
            placeholder="utm_source"
            onChange={(event) => onChange({ ...condition, key: event.target.value })}
          />
          <Input
            className="w-40"
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
        <Button type="button" variant="ghost" onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  )
}
