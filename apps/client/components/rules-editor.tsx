"use client"

import type { Condition, ConditionType, Platform, Rule } from "@linq/shared"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"
import { useState } from "react"
import { Picker } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useRun } from "../lib/hooks"
import { useUpdateLinkRulesMutation } from "../lib/store/links"

/** A rule being edited. Position is implied by array order, as it is on the wire. */
export type RuleDraft = { destination: string; conditions: Condition[] }

export const CONDITION_OPTIONS: { value: ConditionType; label: string }[] = [
  { value: "platform", label: "Platform is" },
  { value: "query_param", label: "Query parameter" },
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

/**
 * Reusable list of rule drafts. Used both by the standalone RulesEditor on the
 * link detail page, and embedded directly inside LinkFormDialog.
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
  /** Applies a change to one rule. */
  function edit(index: number, next: Partial<RuleDraft>) {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)))
  }

  /** Moves a rule up or down; order here is the only thing that breaks a tie. */
  function move(index: number, by: -1 | 1) {
    const target = index + by
    if (target < 0 || target >= rules.length) return
    const next = [...rules]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <p className="py-2 text-center text-sm text-muted-foreground">
          No rules. Every visitor goes to the default destination.
        </p>
      ) : null}

      {rules.map((rule, index) => (
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
                  disabled={index === rules.length - 1}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => onChange(rules.filter((_, i) => i !== index))}
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
                    conditions: rule.conditions.map((c, i) => (i === conditionIndex ? next : c)),
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

      {readOnly ? null : (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          onClick={() =>
            onChange([...rules, { destination: "", conditions: [blankCondition("platform")] }])
          }
        >
          Add rule
        </Button>
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
  linkId,
  rules,
  readOnly,
}: {
  linkId: string
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
    return run(() => updateRules({ linkId, rules: drafts }).unwrap(), {
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
