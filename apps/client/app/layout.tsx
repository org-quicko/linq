import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Providers } from "@/components/providers"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

export const metadata: Metadata = {
  title: "linq admin",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <Providers>{children}</Providers>
        {/* Every failed write lands here; nothing else in the UI reports one. */}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  )
}
