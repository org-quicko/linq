"use client"

import { cn } from "cn"
import NextLink from "next/link"
import { CopyButton } from "@/components/common"

type ShortLinkLike = { domain_host: string; slug: string; short_url: string }

/** The plain "host/slug" text, for contexts that need a string, not markup —
 *  a dialog title (`Purge ${shortLinkText(link)}?`) chief among them. */
export function shortLinkText(link: Pick<ShortLinkLike, "domain_host" | "slug">): string {
  return `${link.domain_host}/${link.slug}`
}

/**
 * Renders "host/slug" paired with a copy button — and the copy button always
 * copies `link.short_url`, the server-built value, never a re-derived string.
 * Before this existed, three rows built their own scheme-less
 * `{domain_host}/{slug}` display text right next to a `CopyButton` that
 * copied a *different* value (`short_url`, which includes the scheme): the
 * text you read and the text you copied were not the same string.
 */
export function ShortLink({
  link,
  href,
  copy = true,
  className,
}: {
  link: ShortLinkLike
  /** Wraps the text in a `next/link` to the detail page when given. */
  href?: string
  copy?: boolean
  className?: string
}) {
  const text = shortLinkText(link)

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {href ? (
        <NextLink
          href={href}
          className={cn(
            "block min-w-0 truncate font-medium underline-offset-2 hover:underline",
            className,
          )}
        >
          {text}
        </NextLink>
      ) : (
        <span className={cn("block min-w-0 truncate", className)}>{text}</span>
      )}
      {copy ? <CopyButton value={link.short_url} /> : null}
    </span>
  )
}
