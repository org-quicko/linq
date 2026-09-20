"use client"

import { cn } from "cn"
import NextLink from "next/link"
import { CopyButton } from "@/components/common"

type ShortLinkLike = { domainHost: string; slug: string; shortUrl: string }

/** The plain "host/slug" text, for contexts that need a string, not markup —
 *  a dialog title (`Purge ${shortLinkText(link)}?`) chief among them. */
export function shortLinkText(link: Pick<ShortLinkLike, "domainHost" | "slug">): string {
  return `${link.domainHost}/${link.slug}`
}

/**
 * Renders "host/slug" paired with a copy button — and the copy button always
 * copies `link.shortUrl`, the server-built value, never a re-derived string.
 * Before this existed, three rows built their own scheme-less
 * `{domainHost}/{slug}` display text right next to a `CopyButton` that
 * copied a *different* value (`shortUrl`, which includes the scheme): the
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
            "min-w-0 truncate font-medium underline-offset-2 hover:underline",
            className,
          )}
        >
          {text}
        </NextLink>
      ) : (
        <span className={cn("truncate", className)}>{text}</span>
      )}
      {copy ? <CopyButton value={link.shortUrl} /> : null}
    </span>
  )
}
