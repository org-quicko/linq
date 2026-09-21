"use client"

import { QR_PATTERNS, type QrCode } from "@linq/shared"
import { skipToken } from "@reduxjs/toolkit/query/react"
import { Download } from "lucide-react"
import { useState } from "react"
import { Field, Picker } from "@/components/common"
import { LinkFilter, ShortLink } from "@/components/patterns"
import { QrPreview } from "@/components/qr-preview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useRun } from "../lib/hooks"
import { downloadQr } from "../lib/qr"
import { useGetLinkQuery } from "../lib/store/links"
import { useCreateQrCodeMutation, useUpdateQrCodeMutation } from "../lib/store/qr-codes"

const PATTERN_LABELS: Record<(typeof QR_PATTERNS)[number], string> = {
  squares: "Squares",
  rounded: "Rounded",
  dots: "Dots",
}

/**
 * Create and edit in one component, per plans/Plan_31.md §A4 — the call site
 * keys it `${mode}-${id}` to force a remount, exactly as `link-form-dialog.tsx`.
 * The preview leads: it is the point of the dialog, so it sits above the
 * fields rather than beside them, staying in view as the form scrolls.
 */
export function QrFormDialog({
  open,
  onOpenChange,
  mode,
  qrCode,
  presetLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  qrCode?: QrCode
  /** Create mode only: opened from a link row that already knows which link
   *  it's for, so the "Short link" field is frozen instead of shown as a
   *  picker — same treatment edit mode already gives a saved QR code's link. */
  presetLink?: { id: string; name: string }
}) {
  const [link_id, setLinkId] = useState(qrCode?.link_id ?? presetLink?.id ?? "")
  const [link_name, setLinkName] = useState(
    qrCode?.link_name ?? qrCode?.slug ?? presetLink?.name ?? "",
  )
  const [name, setName] = useState(qrCode?.name ?? "")
  const [dot_color, setDotColor] = useState(qrCode?.dot_color ?? "#000000")
  const [bg_color, setBgColor] = useState(qrCode?.bg_color ?? "#ffffff")
  const [pattern, setPattern] = useState<(typeof QR_PATTERNS)[number]>(qrCode?.pattern ?? "squares")

  // In create mode the preview's short_url comes off the picked link, live
  // before anything is saved; in edit mode it is already on the record.
  const linked = useGetLinkQuery(mode === "create" && link_id ? link_id : skipToken)
  const short_url = mode === "edit" ? (qrCode?.short_url ?? "") : (linked.data?.short_url ?? "")

  const [createQrCode] = useCreateQrCodeMutation()
  const [updateQrCode] = useUpdateQrCodeMutation()
  const { run, saving } = useRun()

  function submit() {
    const body = { name: name.trim() || null, dot_color, bg_color, pattern }
    if (mode === "create") {
      run(() => createQrCode({ link_id, ...body }).unwrap(), {
        success: "QR code created.",
        fallback: "Could not create that QR code.",
        onSuccess: () => onOpenChange(false),
      })
      return
    }
    if (!qrCode) return
    run(() => updateQrCode({ id: qrCode.id, body }).unwrap(), {
      success: "QR code updated.",
      fallback: "Could not update that QR code.",
      onSuccess: () => onOpenChange(false),
    })
  }

  const config = { short_url, dot_color, bg_color, pattern }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create QR code" : "Edit QR code"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4">
          {short_url ? (
            <QrPreview config={config} size={160} />
          ) : (
            <div className="flex size-40 items-center justify-center text-center text-xs text-muted-foreground">
              Pick a short link to preview
            </div>
          )}
          <div className="flex gap-2">
            {(["png", "jpeg", "svg"] as const).map((extension) => (
              <Button
                key={extension}
                type="button"
                variant="outline"
                size="sm"
                disabled={!short_url}
                onClick={() => downloadQr(config, name.trim() || "qr-code", extension)}
              >
                <Download />
                {extension.toUpperCase()}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Field
            label="Short link"
            hint={mode === "edit" || presetLink ? "Can't be changed after creation." : undefined}
          >
            {mode === "edit" && qrCode ? (
              <div className="flex h-9 items-center rounded-lg border bg-muted px-2.5 text-[12.5px]">
                <ShortLink link={qrCode} copy={false} />
              </div>
            ) : presetLink ? (
              <div className="flex h-9 items-center rounded-lg border bg-muted px-2.5 text-[12.5px]">
                {link_name}
              </div>
            ) : (
              <LinkFilter
                value={link_id}
                name={link_name}
                status="active"
                onSelect={(id, nm) => {
                  setLinkId(id)
                  setLinkName(nm)
                }}
              />
            )}
          </Field>

          <Field label="Title" hint="Optional, for your own reference.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="No title" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <ColorField label="Code colour" value={dot_color} onChange={setDotColor} />
            <ColorField label="Background" value={bg_color} onChange={setBgColor} />
          </div>

          <Field label="Pattern">
            <Picker
              value={pattern}
              onChange={(value) => setPattern(value as (typeof QR_PATTERNS)[number])}
              options={QR_PATTERNS.map((p) => ({ value: p, label: PATTERN_LABELS[p] }))}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || !link_id} onClick={submit}>
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A native colour swatch fused to a text input in one bordered control — no
 *  colour-picker dependency; the text half is what makes a brand hex
 *  pasteable, which the native swatch alone does not allow. */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field label={label}>
      <div className="flex h-9 items-center gap-2 rounded-lg border px-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="size-5 shrink-0 cursor-pointer rounded-sm border-0 bg-transparent p-0"
          aria-label={label}
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-auto border-0 px-0 shadow-none focus-visible:ring-0"
        />
      </div>
    </Field>
  )
}
