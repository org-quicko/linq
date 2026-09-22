"use client"

import { CalendarDays, CheckIcon, CopyIcon } from "lucide-react"
import { type ComponentProps, type ReactNode, useState } from "react"
import { EmptyState } from "@/components/patterns/empty-state"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isWindowWithinYear, RANGES, type Range } from "@/lib/hooks"

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
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
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

/**
 * `StatCard`'s (@/components/patterns) loading twin — same `Card`/
 * `CardContent` wrapper as the real tile, so the skeleton and the thing it
 * stands in for are the same size. It used to be a bare `div`, which the
 * Plan 27 duplication audit flagged: a skeleton with a different box model
 * than what it replaces jitters the layout the instant real data arrives.
 */
export function CardSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-16" />
      </CardContent>
    </Card>
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
      {!isLoading && !error && empty ? <EmptyState message={emptyMessage} /> : null}
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

  const button = (
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

  // Icon-only (no visible `label`) is the common case — e.g. the copy glyph
  // next to every short link row — so it needs a hover tooltip to be
  // identifiable. A button with its own visible text doesn't.
  if (label) return button

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  )
}

/**
 * "3d ago" / "in 2h" — compact, matching the design's style. Falls back to a
 * plain date once something is roughly a month old, where a relative count
 * stops being useful and a reader wants the actual date instead.
 */
function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const abs = Math.abs(ms)
  const future = ms < 0

  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  const WEEK = 7 * DAY
  const MONTH = 30 * DAY

  if (abs < MINUTE) return "just now"
  const span =
    abs < HOUR
      ? `${Math.floor(abs / MINUTE)}m`
      : abs < DAY
        ? `${Math.floor(abs / HOUR)}h`
        : abs < WEEK
          ? `${Math.floor(abs / DAY)}d`
          : abs < MONTH
            ? `${Math.floor(abs / WEEK)}w`
            : null
  if (span === null) return new Date(iso).toLocaleDateString()
  return future ? `in ${span}` : `${span} ago`
}

/**
 * A short, local rendering of an ISO timestamp. `relative` switches it to
 * "3d ago" style; either way the element is the same `<time dateTime>`, with
 * the exact value in `title` when relative, so it stays reachable on hover
 * and to assistive tech regardless of which style is showing.
 */
export function When({ iso, relative }: { iso: string; relative?: boolean }) {
  return (
    <time
      dateTime={iso}
      className="whitespace-nowrap text-muted-foreground"
      title={relative ? new Date(iso).toLocaleString() : undefined}
    >
      {relative ? relativeTime(iso) : new Date(iso).toLocaleString()}
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
 *
 * `ariaLabel` is for an icon-only trigger (Archives' row actions), where
 * `children` carries no visible text of its own to name the button by — it
 * also gets a hover tooltip on that trigger, same as `IconButton`
 * (@/components/patterns), so the row reads the same on hover whichever of
 * the two it's using.
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
  className,
  ariaLabel,
  children,
}: {
  title: string
  /** A plain sentence renders the same as always; pass a `<ul>` (or any
   *  other block content) when the confirmation has more than one point to
   *  make — `asChild` below hands Radix's description slot to a `<div>`
   *  instead of forcing everything through a `<p>`, which cannot contain one. */
  description: ReactNode
  confirmLabel?: string
  confirmText?: string
  onConfirm: () => void
  disabled?: boolean
  variant?: ComponentProps<typeof Button>["variant"]
  size?: ComponentProps<typeof Button>["size"]
  className?: string
  ariaLabel?: string
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

  const trigger = (
    <Button
      type="button"
      variant={variant}
      size={size}
      disabled={disabled}
      aria-label={ariaLabel}
      className={className}
    >
      {children}
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={setOpenState}>
      {/* `ariaLabel` only gets set for an icon-only trigger (no visible text
          of its own), so that's also exactly when it needs a hover tooltip.
          `Tooltip` has to sit outside `DialogTrigger` here, not the other way
          round — `Tooltip`'s Radix root renders no DOM of its own to clone
          props onto, so a `DialogTrigger asChild` wrapping it would never see
          the click that's supposed to open the dialog. `DialogTrigger` is a
          real forwarding primitive, so nesting it inside `TooltipTrigger`
          composes cleanly instead. */}
      {ariaLabel ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>{ariaLabel}</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription asChild>
            <div>{description}</div>
          </DialogDescription>
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
 * The UI half of `useRange` (@/lib/hooks). The popover keeps editable custom
 * dates out of menu semantics while the hook owns the API window.
 */
export function RangePicker({
  preset,
  custom,
  label,
  onPreset,
  onCustom,
}: {
  preset: Range | "custom"
  custom: { from: string; to: string } | null
  label: string
  onPreset: (range: Range) => void
  onCustom: (range: { from: string; to: string }) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const earliest = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  const [from, setFrom] = useState(custom?.from ?? "")
  const [to, setTo] = useState(custom?.to ?? "")
  const [open, setOpen] = useState(false)
  const invalid = Boolean(from && to && (from > to || !isWindowWithinYear(from, to)))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="min-w-36 justify-between">
          <CalendarDays className="size-4 text-muted-foreground" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-0 p-2">
        <div className="space-y-1">
          {RANGES.map((range) => (
            <button
              key={range.value}
              type="button"
              className="flex w-full cursor-pointer items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                onPreset(range.value)
                setOpen(false)
              }}
            >
              <span className="flex-1">{range.label}</span>
              {preset === range.value ? <CheckIcon className="size-4" /> : null}
            </button>
          ))}
        </div>
        <div className="mt-2 space-y-3 border-t px-2 pt-3 pb-1">
          <div>
            <p className="text-sm font-medium">Custom range</p>
            <p className="text-xs text-muted-foreground">Choose up to one year of daily data.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Label className="gap-1 text-xs text-muted-foreground">
              From
              <Input
                type="date"
                value={from}
                min={earliest}
                max={today}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Label>
            <Label className="gap-1 text-xs text-muted-foreground">
              To
              <Input
                type="date"
                value={to}
                min={earliest}
                max={today}
                onChange={(e) => setTo(e.target.value)}
              />
            </Label>
          </div>
          {invalid ? (
            <p className="text-xs text-destructive">Pick a range of one year or less.</p>
          ) : null}
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={!from || !to || invalid}
            onClick={() => {
              onCustom({ from, to })
              setOpen(false)
            }}
          >
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Offset pagination, shown only when there is more than one page of anything.
 * The caller owns `offset` because it is also the thing a filter change has to
 * reset.
 */
export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number
  limit: number
  offset: number
  onChange: (offset: number) => void
}) {
  if (total <= limit) return null
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {offset + 1}–{Math.min(offset + limit, total)} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={offset + limit >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
