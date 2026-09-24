"use client"

import { cn } from "cn"
import { Monitor, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

/**
 * Light / Dark / System. Renders every segment as inactive until mounted:
 * `next-themes` only knows the real value (from localStorage or the OS)
 * once it runs on the client, so the statically-exported HTML has no way to
 * render the right one — showing a guess there would be a guess the visitor
 * never made, and it would flip the instant hydration ran anyway.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  return (
    // Each button already carries its own aria-label ("Light"/"Dark"/"System"),
    // so the group itself needs no role — biome's a11y rules want a <fieldset>
    // for a labelled role="group", which is a form-legend pattern that does
    // not fit three self-describing buttons.
    <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={mounted && theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            "flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground",
            mounted && theme === value && "bg-muted text-foreground",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}
