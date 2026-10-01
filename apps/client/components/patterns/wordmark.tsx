import { cn } from "cn"
import Image from "next/image"
import dark from "@/assets/linq-wordmark-dark.svg"
import light from "@/assets/linq-wordmark-light.svg"

/**
 * The Linq logo, in the variant that reads on the current theme: white artwork
 * for dark mode, near-black for light. Both are rendered and the app's theme
 * class picks one, which an <img> could not otherwise see.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <Image src={light} alt="linq" priority className={cn("h-8 w-auto dark:hidden", className)} />
      <Image
        src={dark}
        alt="linq"
        priority
        className={cn("hidden h-8 w-auto dark:block", className)}
      />
    </>
  )
}
