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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  qrCode?: QrCode
}) {
  const [linkId, setLinkId] = useState(qrCode?.linkId ?? "")
  const [linkName, setLinkName] = useState(qrCode?.linkName ?? qrCode?.slug ?? "")
  const [name, setName] = useState(qrCode?.name ?? "")
  const [dotColor, setDotColor] = useState(qrCode?.dotColor ?? "#000000")
  const [bgColor, setBgColor] = useState(qrCode?.bgColor ?? "#ffffff")
  const [pattern, setPattern] = useState<(typeof QR_PATTERNS)[number]>(qrCode?.pattern ?? "squares")

  // In create mode the preview's shortUrl comes off the picked link, live
  // before anything is saved; in edit mode it is already on the record.
  const linked = useGetLinkQuery(mode === "create" && linkId ? linkId : skipToken)
  const shortUrl = mode === "edit" ? (qrCode?.shortUrl ?? "") : (linked.data?.shortUrl ?? "")

  const [createQrCode] = useCreateQrCodeMutation()
  const [updateQrCode] = useUpdateQrCodeMutation()
  const { run, saving } = useRun()

  function submit() {
    const body = { name: name.trim() || null, dotColor, bgColor, pattern }
    if (mode === "create") {
      run(() => createQrCode({ linkId, ...body }).unwrap(), {
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

  const config = { shortUrl, dotColor, bgColor, pattern }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "Create QR code" : "Edit QR code"}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/40 p-4">
          {shortUrl ? (
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
                disabled={!shortUrl}
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
            hint={mode === "edit" ? "Can't be changed after creation." : undefined}
          >
            {mode === "edit" && qrCode ? (
              <div className="flex h-9 items-center rounded-lg border bg-muted px-2.5 text-[12.5px]">
                <ShortLink link={qrCode} copy={false} />
              </div>
            ) : (
              <LinkFilter
                value={linkId}
                name={linkName}
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
            <ColorField label="Code colour" value={dotColor} onChange={setDotColor} />
            <ColorField label="Background" value={bgColor} onChange={setBgColor} />
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
          <Button type="button" disabled={saving || !linkId} onClick={submit}>
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
