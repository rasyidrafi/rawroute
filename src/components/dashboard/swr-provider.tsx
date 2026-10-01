import { useMemo, type ReactNode } from "react"
import { SWRConfig } from "swr"
import { useDashboardApi } from "./api-context"

export function DashboardSWRProvider({ children }: { children: ReactNode }) {
  const { fetcher } = useDashboardApi()
  const value = useMemo(() => ({ fetcher, revalidateOnFocus: false, dedupingInterval: 10_000, keepPreviousData: false, provider: () => new Map() }), [fetcher])
  return <SWRConfig value={value}>{children}</SWRConfig>
}
