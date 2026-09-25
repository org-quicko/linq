import { cn } from "cn"
import Image from "next/image"
import wordmark from "@/assets/linq-wordmark.svg"

/**
 * The Linq logo. The asset is the light-mode logo, black on white; `dark:invert`
 * flips it with the app's theme class, which an <img> could not otherwise see.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Image src={wordmark} alt="Linq" priority className={cn("h-8 w-auto dark:invert", className)} />
  )
}
