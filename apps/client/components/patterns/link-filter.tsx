"use client"

import { Command as CommandPrimitive } from "cmdk"
import { Link2, X } from "lucide-react"
import { useRef, useState } from "react"
import { CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useDebounced } from "@/lib/hooks"
import { useListLinksQuery } from "@/lib/store/links"

/**
 * A single-select, search-as-you-type link combobox. Lifted out of
 * `analytics-overview.tsx` so the QR create/edit dialog's short-link
 * picker doesn't reimplement it. The field itself is the search box; the
 * popover only lists matches.
 */
export function LinkFilter({
  value,
  name,
  onSelect,
  onClear,
  status,
  placeholder = "Search links",
  className,
}: {
  value: string
  name: string
  onSelect: (id: string, name: string) => void
  onClear?: () => void
  /** Narrows the candidates — the QR dialog only offers active links, since
   *  the server refuses to attach one to an archived link. */
  status?: "active" | "archived" | "all"
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const anchorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(search)
  const links = useListLinksQuery(
    { search: debounced || undefined, status, limit: 8 },
    { skip: !open },
  )
  const rows = links.data?.data ?? []

  function openList() {
    if (open) return
    setSearch("")
    setOpen(true)
  }

  return (
    <CommandPrimitive shouldFilter={false} className={className ?? "relative"}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div
            ref={anchorRef}
            className="flex h-9 w-64 cursor-text items-center gap-1.5 rounded-lg border bg-background px-2.5 pr-7 text-[12.5px] focus-within:ring-2 focus-within:ring-ring/50"
            onClick={() => inputRef.current?.focus()}
          >
            <Link2 className="size-[13px] shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              ref={inputRef}
              value={open ? search : value ? name : ""}
              onValueChange={(next) => {
                setSearch(next)
                setOpen(true)
              }}
              onFocus={openList}
              onClick={openList}
              placeholder={value && open ? name : placeholder}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-64 p-1"
          // Focus stays in the field, and clicking the field isn't "outside".
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
          }}
        >
          <CommandList>
            <CommandEmpty>{links.isFetching ? "Searching…" : "No links found."}</CommandEmpty>
            <CommandGroup>
              {rows.map((link) => (
                <CommandItem
                  key={link.id}
                  value={link.id}
                  onSelect={() => {
                    onSelect(link.id, link.name ?? link.slug)
                    setOpen(false)
                    inputRef.current?.blur()
                  }}
                >
                  <span className="truncate">{link.name ?? link.slug}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </PopoverContent>
      </Popover>
      {value && onClear ? (
        <button
          type="button"
          aria-label="Clear link filter"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded-sm p-0.5 hover:bg-border"
          onClick={() => onClear()}
        >
          <X className="size-[11px]" />
        </button>
      ) : null}
    </CommandPrimitive>
  )
}
