"use client"

import type { ReactNode } from "react"
import { Provider } from "react-redux"
import { store } from "@/lib/store"

export function Providers({ children }: { children: ReactNode }) {
  return <Provider store={store}>{children}</Provider>
}
