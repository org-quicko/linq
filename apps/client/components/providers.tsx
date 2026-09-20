"use client"

import { ThemeProvider } from "next-themes"
import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { store } from "@/lib/store"

export function Providers({ children }: { children: ReactNode }) {
  return (
    <Provider store={store}>
      {/*
       * disableTransitionOnChange matters here: the shell's nav links carry
       * `transition-colors`, and without it every theme switch animates the
       * whole sidebar as each element's colors interpolate one at a time.
       */}
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        {children}
      </ThemeProvider>
    </Provider>
  )
}
