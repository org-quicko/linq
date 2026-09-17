"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/** One row of the editor's list state; the wire shape is a `Record<string, string>` map. */
export type PresetParamRow = { key: string; value: string }

/** Seeds the editor's row list from the wire shape. */
export function presetParamsToRows(presetParams: Record<string, string>): PresetParamRow[] {
  return Object.entries(presetParams).map(([key, value]) => ({ key, value }))
}

/**
 * Converts the editor's row list back to the wire shape. Rows with a blank key
 * are dropped, and a duplicate key keeps the last row's value — the same thing
 * assigning into an object would do.
 */
export function rowsToPresetParams(rows: PresetParamRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key) out[key] = row.value
  }
  return out
}

/**
 * Edits the list of key/value preset params on a link, modelled on `ConditionRow`
 * in `rules-editor.tsx` — the only other key/value row in the codebase.
 *
 * Holds a list rather than editing the `Record` directly: renaming a key
 * character by character would otherwise collide with an existing key and lose
 * input focus mid-edit. The parent converts to the map shape on save.
 */
export function PresetParamsEditor({
  rows,
  onChange,
  readOnly,
  forwardQuery,
}: {
  rows: PresetParamRow[]
  onChange: (rows: PresetParamRow[]) => void
  readOnly: boolean
  /**
   * The unsaved `forwardQuery` draft, not the persisted value, so the hint
   * tracks the checkbox whichever of the two fields is set first.
   */
  forwardQuery: boolean
}) {
  function edit(index: number, next: Partial<PresetParamRow>) {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...next } : row)))
  }

  return (
    <div className="flex flex-col gap-2">
      {!forwardQuery ? (
        <p className="text-sm text-muted-foreground">
          Not applied while this link does not forward the query.
        </p>
      ) : null}

      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Input
            className="w-40"
            value={row.key}
            disabled={readOnly}
            placeholder="utm_source"
            onChange={(event) => edit(index, { key: event.target.value })}
          />
          <Input
            className="w-40"
            value={row.value}
            disabled={readOnly}
            placeholder="qr"
            onChange={(event) => edit(index, { value: event.target.value })}
          />
          {readOnly ? null : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          )}
        </div>
      ))}

      {readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          className="self-start"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          + Add parameter
        </Button>
      )}
    </div>
  )
}
