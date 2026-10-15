import { useState } from "react"
import useSWR from "swr"
import { useDashboardApi } from "@/components/dashboard/api-context"
import { overviewRange, type OverviewPayload, type OverviewPeriod } from "@/lib/overview"
import type { RequestLogsPage } from "@/lib/request-logs"

export function useOverview() {
  const { workspaceId, fetcher } = useDashboardApi()
  const [period, setPeriod] = useState<OverviewPeriod>("24h")
  const [range, setRange] = useState(() => overviewRange("24h"))
  const params = new URLSearchParams(range)
  const url = `/api/admin/overview?${params}`
  const recentUrl = `/api/admin/request-logs?${params}`
  const options = { keepPreviousData: false, revalidateOnFocus: false, shouldRetryOnError: false }
  const aggregate = useSWR<OverviewPayload>(workspaceId ? [workspaceId, url] : null, () => fetcher<OverviewPayload>(url), options)
  const recent = useSWR<RequestLogsPage>(workspaceId ? [workspaceId, recentUrl] : null, () => fetcher<RequestLogsPage>(recentUrl), options)
  return {
    aggregate, recent, period, workspaceId,
    setPeriod(value: OverviewPeriod) { setPeriod(value); setRange(overviewRange(value)) },
    refresh() { setRange(overviewRange(period)) },
  }
}
