"use client"

import { Link2, X } from "lucide-react"
import { useState } from "react"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useDebounced } from "@/lib/hooks"
import { useListLinksQuery } from "@/lib/store/links"

/**
 * A single-select, search-as-you-type link combobox. Lifted out of
 * `analytics-overview.tsx` (plans/Plan_31.md §A4) so the QR create/edit
 * dialog's short-link picker doesn't reimplement it.
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
  const debounced = useDebounced(search)
  const links = useListLinksQuery(
    { search: debounced || undefined, status, limit: 8 },
    { skip: !open },
  )
  const rows = links.data?.data ?? []

  return (
    <div className={className ?? "relative"}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-9 w-64 items-center gap-1.5 rounded-lg border bg-background px-2.5 pr-7 text-[12.5px]"
          >
            <Link2 className="size-[13px] shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">
              {value ? name : <span className="text-muted-foreground">{placeholder}</span>}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder={placeholder} value={search} onValueChange={setSearch} />
            <CommandList>
              <CommandEmpty>No links found.</CommandEmpty>
              <CommandGroup>
                {rows.map((link) => (
                  <CommandItem
                    key={link.id}
                    value={link.id}
                    onSelect={() => {
                      onSelect(link.id, link.name ?? link.slug)
                      setOpen(false)
                    }}
                  >
                    <span className="truncate">{link.name ?? link.slug}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && onClear ? (
        <button
          type="button"
          aria-label="Clear link filter"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 hover:bg-border"
          onClick={() => onClear()}
        >
          <X className="size-[11px]" />
        </button>
      ) : null}
    </div>
  )
}
