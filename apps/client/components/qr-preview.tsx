"use client"

import type QRCodeStyling from "qr-code-styling"
import { useEffect, useRef } from "react"
import { type QrStyleConfig, qrOptions } from "@/lib/qr"

/**
 * Drives the imperative `qr-code-styling` library from React: a ref for the
 * container React renders empty on purpose, one instance across renders,
 * `update()` after the first (plans/Plan_31.md §A5) — constructing a new one
 * per keystroke would visibly flicker while someone is dragging a colour.
 *
 * SVG here, always: crisp at any CSS size, no `devicePixelRatio` handling.
 * PNG/JPEG downloads go through `lib/qr.ts`'s own throwaway canvas instance.
 */
export function QrPreview({ config, size }: { config: QrStyleConfig; size: number }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<QRCodeStyling | null>(null)

  // The primitives, never `config` itself, are the deps — a fresh literal
  // each render would re-run this on every unrelated keystroke in the form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    let cancelled = false
    const options = { ...qrOptions(config, size), type: "svg" as const }

    void (async () => {
      const { default: QRCodeStylingCtor } = await import("qr-code-styling")
      if (cancelled || !host.current) return
      if (instance.current) instance.current.update(options)
      else {
        instance.current = new QRCodeStylingCtor(options)
        instance.current.append(host.current)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [config.shortUrl, config.dotColor, config.bgColor, config.pattern, size])

  return (
    <div
      ref={host}
      role="img"
      aria-label={`QR code for ${config.shortUrl}`}
      className="flex items-center justify-center"
    />
  )
}
