"use client"

import { ChevronDown, Globe } from "lucide-react"
import { Picker } from "@/components/common"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useListDomainsQuery } from "@/lib/store/domains"

/** Radix refuses an item whose value is the empty string, so "no filter"
 *  needs a real sentinel — this is the one place that has to know about it. */
const ANY_DOMAIN = "__any__"

/**
 * A domain filter. Single-select by default — owning its own domain list and
 * the empty-string sentinel above, so a page just holds `domain_id: string`,
 * `""` meaning all — for the two scoped-to-one-domain call sites
 * (`app/analytics/page.tsx`'s Visits and Orphans sections, which feed a
 * single `domain_id` into analytics and raw-visit requests).
 *
 * `multiple` switches it to a checkbox dropdown returning a comma-separated
 * id list, for the links list (docs/plans/Plan_31.md §B3):
 * `linkListQuerySchema.domain_id` accepts both a lone uuid and a
 * comma-separated list, so this is the only other caller that needs the
 * plural shape.
 */
export function DomainPicker({
  value,
  onChange,
  className,
  multiple = false,
}: {
  value: string
  onChange: (domain_id: string) => void
  className?: string
  multiple?: boolean
}) {
  const domains = useListDomainsQuery({ limit: 200 })
  const rows = domains.data?.data ?? []

  if (multiple) {
    const selected = value ? value.split(",").filter(Boolean) : []
    const toggle = (id: string) => {
      const next = selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]
      onChange(next.join(","))
    }

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" className={className}>
            <Globe className="size-3.5" />
            {selected.length ? `Domain (${selected.length})` : "Domain"}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {rows.map((domain) => (
            <DropdownMenuCheckboxItem
              key={domain.id}
              checked={selected.includes(domain.id)}
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={() => toggle(domain.id)}
            >
              {domain.host}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Picker
      className={className}
      value={value || ANY_DOMAIN}
      onChange={(next) => onChange(next === ANY_DOMAIN ? "" : next)}
      options={[
        { value: ANY_DOMAIN, label: "All domains" },
        ...rows.map((domain) => ({ value: domain.id, label: domain.host })),
      ]}
    />
  )
}
