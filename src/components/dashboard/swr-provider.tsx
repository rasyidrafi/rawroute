"use client"

import { SWRConfig } from "swr"
import type { ReactNode } from "react"

import { fetcher } from "@/components/dashboard/api"

export function DashboardSWRProvider({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ fetcher, revalidateOnFocus: false, dedupingInterval: 10_000, keepPreviousData: true, provider: () => new Map() }}>{children}</SWRConfig>
}
