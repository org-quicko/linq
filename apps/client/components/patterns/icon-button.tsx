"use client"

import { cn } from "cn"
import type { ComponentProps, ComponentType } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The design's 40px square row action, wrapping a real Radix `Tooltip`
 * rather than the mockup's CSS `::after` hover label — a focus-visible
 * trigger reaches this one, and the CSS version is invisible to keyboard
 * users. Built on the existing `Button` rather than a bare element, so it
 * inherits the same hover/focus/active/disabled handling as every other
 * button in the app; `size="icon"` (32px) is just overridden to 40px, since
 * nothing else about that variant needed reinventing.
 */
export function IconButton({
  icon: Icon,
  label,
  variant = "ghost",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "children" | "aria-label"> & {
  icon: ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size="icon"
          aria-label={label}
          className={cn("size-10", className)}
          {...props}
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
