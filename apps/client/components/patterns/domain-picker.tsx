"use client"

import { Picker } from "@/components/common"
import { useListDomainsQuery } from "@/lib/store/domains"

/** Radix refuses an item whose value is the empty string, so "no filter"
 *  needs a real sentinel — this is the one place that has to know about it. */
const ANY_DOMAIN = "__any__"

/**
 * A domain filter: owns its own domain list and the empty-string sentinel
 * above, so a page just holds `domainId: string`, `""` meaning all. The
 * sentinel, its comment, and the round-trip through it had been copied by
 * hand into the Links, Orphans and Visits pages.
 */
export function DomainPicker({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (domainId: string) => void
  className?: string
}) {
  const domains = useListDomainsQuery({ limit: 200 })

  return (
    <Picker
      className={className}
      value={value || ANY_DOMAIN}
      onChange={(next) => onChange(next === ANY_DOMAIN ? "" : next)}
      options={[
        { value: ANY_DOMAIN, label: "All domains" },
        ...(domains.data?.data ?? []).map((domain) => ({
          value: domain.id,
          label: domain.host,
        })),
      ]}
    />
  )
}
