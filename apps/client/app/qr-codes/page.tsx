"use client"

import { type Actor, can, type QrCode } from "@linq/shared"
import { MoreVertical, Pencil, QrCode as QrCodeIcon, Search, Trash2 } from "lucide-react"
import { useState } from "react"
import { AppShell } from "@/components/app-shell"
import {
  Collection,
  IconButton,
  PageHeader,
  RowCard,
  RowCardTile,
  ShortLink,
} from "@/components/patterns"
import { QrFormDialog } from "@/components/qr-form-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useDebounced, useRun } from "../../lib/hooks"
import { useDeleteQrCodeMutation, useListQrCodesQuery } from "../../lib/store/qr-codes"

/** Create/edit share one dialog; `null` means closed. */
type DialogState = { mode: "create" | "edit"; qrCode?: QrCode } | null

export default function QrCodesPage() {
  return <AppShell>{(actor) => <QrCodesList actor={actor} />}</AppShell>
}

function QrCodesList({ actor }: { actor: Actor }) {
  const [search, setSearch] = useState("")
  const [dialog, setDialog] = useState<DialogState>(null)
  const settledSearch = useDebounced(search)

  const qrCodes = useListQrCodesQuery({ search: settledSearch || undefined, limit: 200 })
  const rows = qrCodes.data?.data ?? []

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto px-7 py-6">
      <PageHeader
        title="QR codes"
        actions={
          <Button type="button" onClick={() => setDialog({ mode: "create" })}>
            Create QR code
          </Button>
        }
      />

      <InputGroup className="w-[300px]">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          placeholder="Search QR codes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </InputGroup>

      <Collection
        query={qrCodes}
        rows={rows}
        variant="list"
        emptyMessage="No QR codes yet. Create one from a short link."
      >
        {(qrCode: QrCode) => (
          <QrCodeRow
            key={qrCode.id}
            actor={actor}
            qrCode={qrCode}
            onEdit={() => setDialog({ mode: "edit", qrCode })}
          />
        )}
      </Collection>

      {dialog ? (
        <QrFormDialog
          key={`${dialog.mode}-${dialog.qrCode?.id ?? "new"}`}
          open
          onOpenChange={(next) => !next && setDialog(null)}
          mode={dialog.mode}
          qrCode={dialog.qrCode}
        />
      ) : null}
    </div>
  )
}

function QrCodeRow({
  actor,
  qrCode,
  onEdit,
}: {
  actor: Actor
  qrCode: QrCode
  onEdit: () => void
}) {
  const [deleteQrCode] = useDeleteQrCodeMutation()
  const { run } = useRun()
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The client-side courtesy check (plans/Plan_31.md §A1): an adapter object,
  // never a bare `qrCode.ownerId` — a QR code has no owner of its own.
  const editable = can.editLink(actor, { ownerId: qrCode.linkOwnerId })

  return (
    <>
      <RowCard
        tile={
          // A colour swatch, not a live render: a 40px QR is unreadable, and
          // rendering one per row costs a library instance and an SVG render
          // per row to convey nothing. The swatch still shows the styling.
          <RowCardTile style={{ backgroundColor: qrCode.bgColor }}>
            <QrCodeIcon className="size-4" style={{ color: qrCode.dotColor }} />
          </RowCardTile>
        }
        actions={
          editable ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton icon={MoreVertical} label="Row actions" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>
                  <Pencil />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      >
        <div className="flex items-center gap-2 min-w-0">
          {qrCode.name ? (
            <span className="truncate text-sm font-semibold">{qrCode.name}</span>
          ) : null}
          {/* No adapter object needed here: `slug`/`domainHost`/`shortUrl` are
           *  unprefixed on `QrCode` so it satisfies `ShortLinkLike` directly. */}
          <ShortLink link={qrCode} />
        </div>
      </RowCard>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this QR code?</DialogTitle>
            <DialogDescription>
              This deletes the saved styling. Printed codes keep working — archive the link itself
              to stop it resolving.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false)
                run(() => deleteQrCode(qrCode.id).unwrap())
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
