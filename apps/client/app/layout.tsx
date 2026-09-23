import type { Metadata } from "next"
import localFont from "next/font/local"
import type { ReactNode } from "react"
import { Providers } from "@/components/providers"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

/**
 * DM Sans, self-hosted rather than pulled through `next/font/google`: the
 * Client UI is a static export built inside the Docker image, so a build-time
 * fetch would make the build need network access. See `globals.css` for the
 * rest of the reasoning.
 *
 * One file, not three: Google serves the identical variable-font woff2 for
 * every weight in DM Sans' 100–1000 axis (confirmed by requesting 400, 500,
 * 600 and the full range — all four resolve to the same URL), so a single
 * `weight: "400 600"` range covers the whole 400/500/600 scale the design
 * uses. `fallback` repeats the stack the app already shipped, so a failed
 * load degrades to exactly today's rendering rather than a generic default.
 */
const dmSans = localFont({
  src: "./fonts/DMSans-Variable.woff2",
  weight: "400 600",
  variable: "--font-sans",
  display: "swap",
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
})

export const metadata: Metadata = {
  title: "Linq",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
        {/* Every failed write lands here; nothing else in the UI reports one. */}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  )
}
