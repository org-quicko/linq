"use client"

import { CheckIcon, ChevronsUpDownIcon, XIcon } from "lucide-react"
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
 * Picks tags from the ones already in use, with their counts.
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
}: {
  value: string[]
  onChange: (tags: string[]) => void
  creatable?: boolean
  disabled?: boolean
  placeholder?: string
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
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className="w-full justify-between font-normal"
          >
            <span className={value.length ? undefined : "text-muted-foreground"}>
              {value.length ? `${value.length} selected` : placeholder}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
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
                  <CommandItem key={row.tag} value={row.tag} onSelect={() => toggle(row.tag)}>
                    <CheckIcon className={value.includes(row.tag) ? "opacity-100" : "opacity-0"} />
                    <span className="flex-1">{row.tag}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{row.count}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length ? (
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
