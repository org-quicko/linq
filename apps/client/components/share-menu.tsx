"use client"

import type { Link, QrCode } from "@linq/shared"
import { Mail, Pencil, QrCode as QrCodeIcon, Share2, Trash2 } from "lucide-react"
import { type ReactNode, useState } from "react"
import { ConfirmButton, CopyButton } from "@/components/common"
import { IconButton, shortLinkText } from "@/components/patterns"
import { QrFormDialog } from "@/components/qr-form-dialog"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useRun } from "../lib/hooks"
import { useDeleteQrCodeMutation, useListQrCodesQuery } from "../lib/store/qr-codes"

type Network = {
  name: string
  Icon: (props: { className?: string }) => ReactNode
  href: (url: string, text: string) => string
}

/** `url` goes through every network's own encoding — never interpolated raw
 *  into a template string, since `link.name` is user-entered text. */
const NETWORKS: Network[] = [
  {
    name: "WhatsApp",
    Icon: WhatsAppIcon,
    href: (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
  },
  {
    name: "X",
    Icon: XIcon,
    href: (url, text) =>
      `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  },
  {
    name: "Facebook",
    Icon: FacebookIcon,
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    name: "LinkedIn",
    Icon: LinkedInIcon,
    href: (url) => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
  {
    name: "Email",
    Icon: Mail,
    href: (url, text) =>
      `mailto:?subject=${encodeURIComponent(text)}&body=${encodeURIComponent(url)}`,
  },
]

/**
 * Replaces the standalone QR-codes list page (a browse-all view): sharing
 * and QR generation both start from the link they're for, so
 * both live on the row's own `RowCard` actions instead of a second page a
 * click away. QR codes already saved against this link (`link_id` filter,
 * same endpoint the old page paged over unfiltered) show inline so "generate"
 * doubles as "revisit" without a browse page to find them again.
 */
export function ShareMenu({ link }: { link: Link }) {
  const [open, setOpen] = useState(false)
  const [qrDialog, setQrDialog] = useState<{ mode: "create" | "edit"; qrCode?: QrCode } | null>(
    null,
  )

  const qrCodes = useListQrCodesQuery({ link_id: link.id, limit: 5 })
  const shareText = link.name?.trim() || shortLinkText(link)

  const [deleteQrCode] = useDeleteQrCodeMutation()
  const { run } = useRun()

  function removeQrCode(qrCode: QrCode) {
    return run(() => deleteQrCode(qrCode.id).unwrap(), {
      success: "QR code deleted.",
      fallback: "Could not delete that QR code.",
    })
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <IconButton icon={Share2} label="Share" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <PopoverHeader>
            <PopoverTitle>Share this link</PopoverTitle>
          </PopoverHeader>

          <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {shortLinkText(link)}
            </span>
            <CopyButton value={link.short_url} label="Copy" />
          </div>

          <div className="flex items-center justify-between">
            {NETWORKS.map(({ name, Icon, href }) => (
              <Tooltip key={name}>
                <TooltipTrigger asChild>
                  <Button asChild type="button" variant="outline" size="icon" className="size-9">
                    <a
                      href={href(link.short_url, shareText)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Share on ${name}`}
                    >
                      <Icon className="size-4" />
                    </a>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{name}</TooltipContent>
              </Tooltip>
            ))}
          </div>

          <div className="h-px bg-border" />

          <div className="flex flex-col gap-2">
            {(qrCodes.data?.data ?? []).map((qrCode) => (
              <div
                key={qrCode.id}
                className="flex items-center gap-1 rounded-lg border pr-1 transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => setQrDialog({ mode: "edit", qrCode })}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
                >
                  {/* A colour swatch, not a live render — same call as the row it
                      replaces: a 32px QR is unreadable, and rendering one per
                      row costs a library instance per row to convey nothing
                      beyond what the swatch already shows. */}
                  <div
                    className="flex size-8 shrink-0 items-center justify-center rounded-md"
                    style={{ backgroundColor: qrCode.bg_color }}
                  >
                    <QrCodeIcon className="size-4" style={{ color: qrCode.dot_color }} />
                  </div>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {qrCode.name?.trim() || "QR code"}
                  </span>
                  <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                </button>

                <ConfirmButton
                  size="icon-sm"
                  className="shrink-0"
                  ariaLabel="Delete QR code"
                  title={`Delete ${qrCode.name?.trim() || "this QR code"}?`}
                  description={
                    <ul className="list-disc space-y-1 pl-4">
                      <li>
                        The link itself keeps working — this only removes the QR code's saved
                        style from linq.
                      </li>
                      <li>Any copies you've already printed or shared keep scanning fine.</li>
                      <li>This cannot be undone.</li>
                    </ul>
                  }
                  confirmLabel="Delete"
                  onConfirm={() => removeQrCode(qrCode)}
                >
                  <Trash2 />
                </ConfirmButton>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setQrDialog({ mode: "create" })}
            >
              <QrCodeIcon />
              {qrCodes.data?.data.length ? "New QR code" : "Generate QR code"}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {qrDialog ? (
        <QrFormDialog
          key={`${qrDialog.mode}-${qrDialog.qrCode?.id ?? "new"}`}
          open
          onOpenChange={(next) => {
            if (!next) setQrDialog(null)
          }}
          mode={qrDialog.mode}
          qrCode={qrDialog.qrCode}
          presetLink={
            qrDialog.mode === "create" ? { id: link.id, name: shortLinkText(link) } : undefined
          }
        />
      ) : null}
    </>
  )
}

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M12.01 2C6.5 2 2 6.48 2 11.99c0 1.99.58 3.84 1.6 5.4L2 22l4.75-1.56a9.96 9.96 0 0 0 5.26 1.5h.01c5.5 0 10-4.48 10-9.99C22 6.48 17.51 2 12.01 2Zm5.46 14.38c-.23.65-1.36 1.27-1.87 1.34-.5.08-1.14.1-1.84-.11-.42-.14-.97-.32-1.66-.62-2.93-1.26-4.84-4.2-4.98-4.4-.15-.2-1.2-1.59-1.2-3.03 0-1.44.76-2.15 1.02-2.45.27-.3.59-.37.78-.37.2 0 .39 0 .56.01.18 0 .42-.07.66.5.24.6.83 2.03.9 2.18.07.15.12.32.02.52-.1.2-.15.32-.29.49-.15.17-.31.38-.44.51-.15.15-.3.31-.13.6.17.3.76 1.25 1.63 2.03 1.12 1 2.07 1.31 2.36 1.46.3.15.47.12.64-.07.17-.2.73-.85.93-1.15.2-.29.39-.24.66-.15.27.1 1.7.81 2 .95.29.15.49.22.56.34.07.12.07.71-.16 1.36Z" />
    </svg>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.66l7.73-8.84L1.25 2.25h6.83l4.71 6.23ZM17.08 19.8h1.83L7.08 4.13H5.12Z" />
    </svg>
  )
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.99 3.66 9.13 8.44 9.88v-6.99H7.9V12h2.54V9.8c0-2.5 1.49-3.89 3.78-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56V12h2.78l-.45 2.89h-2.33v6.99C18.34 21.13 22 16.99 22 12Z" />
    </svg>
  )
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29ZM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12ZM7.12 20.45H3.55V9h3.57v11.45Z" />
    </svg>
  )
}
