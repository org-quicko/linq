"use client"

import { CheckIcon, CopyIcon } from "lucide-react"
import { type ComponentProps, type ReactNode, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/**
 * The pieces every page shares that shadcn has no primitive for, plus two thin
 * wrappers over primitives that would otherwise be copied out ten times.
 */

/** A labelled form row. `hint` explains a rule the server enforces. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* The control is the child, which the wrapping label associates implicitly. */}
      <Label className="flex-col items-stretch gap-1.5">
        <span className="text-foreground">{label}</span>
        {children}
      </Label>
      {/*
       * The hint slot is always present, even when empty. A hinted field would
       * otherwise be taller than a bare one, which pushes its control out of
       * line with its neighbours in any row of fields.
       */}
      <span className="min-h-4 text-xs text-muted-foreground">{hint}</span>
    </div>
  )
}

/**
 * A table-shaped placeholder for a list's first load, matching `DataTable`'s
 * own header so the skeleton is a complete, validly-nested table rather than
 * bare rows dropped next to wherever `QueryState` renders it.
 */
export function TableSkeleton({ head, rows = 5 }: { head: ReactNode[]; rows?: number }) {
  return (
    <DataTable head={head}>
      {Array.from({ length: rows }).map((_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <TableRow key={r}>
          {head.map((_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <TableCell key={c}>
              <Skeleton className="h-4 w-full" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </DataTable>
  )
}

/** A stat-card-shaped placeholder, for the overview pages' tiles. */
export function CardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-7 w-16" />
    </div>
  )
}

/**
 * The seam every page's data goes through: a skeleton while there is no data
 * yet, a thin bar over the existing content while a background refetch is in
 * flight, the error text, the empty text, or nothing — meaning the caller
 * should render its real rows. Shaped to match what an RTK Query hook returns,
 * so a call site passes its query result straight through.
 */
export function QueryState({
  isLoading,
  isFetching,
  error,
  empty,
  skeleton,
  emptyMessage = "Nothing here yet.",
}: {
  isLoading: boolean
  isFetching?: boolean
  /** The shape RTK Query hooks actually return: its own error, or a `SerializedError`. */
  error?: { message?: string } | null
  empty?: boolean
  skeleton?: ReactNode
  emptyMessage?: string
}) {
  return (
    <>
      {isFetching && !isLoading ? <LinearProgress /> : null}
      {isLoading
        ? (skeleton ?? <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>)
        : null}
      {!isLoading && error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {error.message ?? "Something went wrong."}
        </p>
      ) : null}
      {!isLoading && !error && empty ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      ) : null}
    </>
  )
}

/** The sweep bar itself: indeterminate, non-blocking, sits above stale content. */
function LinearProgress() {
  return (
    <div
      className="relative mb-2 h-0.5 w-full overflow-hidden rounded-full bg-muted"
      role="status"
      aria-label="Refreshing"
    >
      <div className="absolute inset-y-0 w-1/3 animate-[linear-progress_1.1s_ease-in-out_infinite] rounded-full bg-primary" />
    </div>
  )
}

/** Copies text and briefly says so. Used for short URLs and new API keys. */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      type="button"
      variant="ghost"
      size={label ? "xs" : "icon-xs"}
      aria-label={label ?? "Copy"}
      onClick={() => {
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {label ? (copied ? "Copied" : label) : null}
    </Button>
  )
}

/** A short, local rendering of an ISO timestamp. */
export function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} className="whitespace-nowrap text-muted-foreground">
      {new Date(iso).toLocaleString()}
    </time>
  )
}

/**
 * A table with its header row built from labels. The body is written with the
 * shadcn `TableRow`/`TableCell` primitives directly; only the header is wrapped,
 * because that is the part that was identical in all five tables.
 */
export function DataTable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((cell, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a static header row
            <TableHead key={i}>{cell}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  )
}

export type PickerOption = { value: string; label: string }

/**
 * A single-choice dropdown.
 *
 * Wraps the four-part shadcn `Select` because ten call sites would otherwise
 * repeat it verbatim. Note that Radix refuses an item whose value is the empty
 * string, so an "all" choice needs a real sentinel value at the call site.
 */
export function Picker({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: PickerOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * A button that asks first. Used for the writes that are awkward to undo:
 * archiving a domain, which stops it serving, and revoking a key, which is a
 * real delete.
 *
 * `confirmText` raises the bar for the irreversible ones: the confirm button
 * stays disabled until the operator types that exact word, which for a purge is
 * the slug or the host. It is a speed bump in the browser, never a permission —
 * the server checks the role and the archived status regardless.
 */
export function ConfirmButton({
  title,
  description,
  confirmLabel = "Confirm",
  confirmText,
  onConfirm,
  disabled,
  variant = "destructive",
  size,
  children,
}: {
  title: string
  description: string
  confirmLabel?: string
  confirmText?: string
  onConfirm: () => void
  disabled?: boolean
  variant?: ComponentProps<typeof Button>["variant"]
  size?: ComponentProps<typeof Button>["size"]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")

  // Clearing on every transition means a cancelled dialog cannot be reopened
  // with the confirmation already typed in.
  const setOpenState = (next: boolean) => {
    setOpen(next)
    setTyped("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      <DialogTrigger asChild>
        <Button type="button" variant={variant} size={size} disabled={disabled}>
          {children}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {confirmText && (
          <Field label={`Type ${confirmText} to confirm`}>
            <Input
              value={typed}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmText}
            />
          </Field>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpenState(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={variant}
            disabled={confirmText !== undefined && typed !== confirmText}
            onClick={() => {
              setOpenState(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Required by the CC BY 4.0 licence on the country database, wherever its
 * results are displayed. Not decorative: dropping it ends the grant.
 * See docs/adr/0004.
 */
export function GeoAttribution() {
  return (
    <p className="pt-2 text-xs text-muted-foreground">
      IP Geolocation by{" "}
      <a
        href="https://db-ip.com"
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2"
      >
        DB-IP
      </a>
    </p>
  )
}
