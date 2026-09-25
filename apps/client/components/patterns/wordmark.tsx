import { cn } from "cn"
import Image from "next/image"
import wordmark from "@/assets/linq-wordmark.svg"

/**
 * The Linq logo. The asset is the dark-mode logo, white on black; light mode
 * inverts it. Driven by the app's theme class, which an <img> could not otherwise see.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Image
      src={wordmark}
      alt="Linq"
      priority
      className={cn("h-8 w-auto invert dark:invert-0", className)}
    />
  )
}
