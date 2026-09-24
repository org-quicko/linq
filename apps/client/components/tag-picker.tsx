"use client"

import { cn } from "cn"
import { ChevronDown, ChevronsUpDownIcon, XIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useListTagsQuery } from "../lib/store/stats"

/** The server lowercases tags on the way in, so the picker does too. */
function normalise(tag: string): string {
  return tag.trim().toLowerCase()
}

/**
 * Picks tags from the ones already in use.
 *
 * `GET /v1/tags` is derived from active links, so the list is whatever people
 * actually tagged — there is no tag table to keep in step. That is also why
 * `creatable` exists: a tag becomes real by being put on a link, so the entry
 * form has to accept one that is not in the list yet.
 *
 * Selection is OR, matching the server: a link matches if it carries *any* of
 * the chosen tags.
 */
export function TagPicker({
  value,
  onChange,
  creatable = false,
  disabled = false,
  placeholder = "Tags",
  filter = false,
  className,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  creatable?: boolean
  disabled?: boolean
  placeholder?: string
  /** Toolbar filter look, matching `DomainPicker`: reads `Tag` / `Tag (n)`,
   *  and drops the removable-chip row the form field shows below it. */
  filter?: boolean
  className?: string
}) {
  const { data: tags, isLoading: tagsLoading } = useListTagsQuery()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")

  const known = tags ?? []
  const candidate = normalise(typed)
  // Offer to create only what is genuinely new, so the option never duplicates
  // a row already in the list.
  const showCreate =
    creatable &&
    candidate.length > 0 &&
    !known.some((row) => row.tag === candidate) &&
    !value.includes(candidate)

  function toggle(tag: string) {
    onChange(value.includes(tag) ? value.filter((t) => t !== tag) : [...value, tag])
  }

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {filter ? (
            <Button type="button" variant="outline" disabled={disabled} className={className}>
              {value.length ? `Tag (${value.length})` : "Tag"}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn("w-full justify-between font-normal", className)}
            >
              <span className={value.length ? undefined : "text-muted-foreground"}>
                {value.length ? `${value.length} selected` : placeholder}
              </span>
              <ChevronsUpDownIcon className="opacity-50" />
            </Button>
          )}
        </PopoverTrigger>

        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            <CommandInput
              placeholder={creatable ? "Find or add a tag" : "Find a tag"}
              value={typed}
              onValueChange={setTyped}
            />
            <CommandList>
              <CommandEmpty>{tagsLoading ? "Loading…" : "No tags yet."}</CommandEmpty>

              {showCreate ? (
                <CommandGroup>
                  <CommandItem
                    value={candidate}
                    onSelect={() => {
                      onChange([...value, candidate])
                      setTyped("")
                    }}
                  >
                    Add “{candidate}”
                  </CommandItem>
                </CommandGroup>
              ) : null}

              <CommandGroup>
                {known.map((row) => (
                  <CommandItem
                    key={row.tag}
                    value={row.tag}
                    data-checked={value.includes(row.tag)}
                    onSelect={() => toggle(row.tag)}
                  >
                    {row.tag}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {!filter && value.length ? (
        <div className="flex flex-wrap gap-1">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              {tag}
              {disabled ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${tag}`}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                  onClick={() => toggle(tag)}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
