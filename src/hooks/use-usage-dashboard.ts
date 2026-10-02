import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import type { DateRange } from "react-day-picker"
import type { DashboardPayload, DashboardQuery } from "@/lib/types"
import { DEFAULT_DASHBOARD_QUERY } from "@/lib/dashboard-defaults"
import { calendarDateFromInstant } from "@/lib/timezone"
import { useDashboardApi } from "@/components/dashboard/api-context"
import { DEFAULT_GRANULARITY, formatCalendarSelection, resolveSelectedRange } from "@/components/dashboard/ai/usage-utils"

export function useUsageDashboard({ publicView = false, workspaceId }: { publicView?: boolean; workspaceId?: string } = {}) {
  const { apiFetch } = useDashboardApi()
  const endpoint = publicView ? "/api/public/dashboard" : "/api/admin/usage"
  const defaultPreset: DashboardQuery["preset"] = DEFAULT_DASHBOARD_QUERY.preset
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [preset, setPresetState] = useState<DashboardQuery["preset"]>(defaultPreset)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [granularity, setGranularityState] = useState<NonNullable<DashboardQuery["granularity"]>>(DEFAULT_GRANULARITY)
  const [pending, startTransition] = useTransition()
  const activeRequest = useRef<AbortController | null>(null)
  const selectedRange = useMemo<DateRange | undefined>(() => {
    if (preset === "budget" && dashboard) return { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }
    return resolveSelectedRange(from, to)
  }, [dashboard, from, preset, to])
  const activeGranularity = granularity

  const query = useCallback((nextPreset: DashboardQuery["preset"], nextFrom = "", nextTo = "", nextGranularity = DEFAULT_GRANULARITY) => {
    const params = new URLSearchParams({ preset: nextPreset })
    if (publicView && workspaceId && workspaceId !== "default") params.set("workspace", workspaceId)
    if (nextPreset === "custom") {
      if (nextFrom) params.set("from", nextFrom)
      if (nextTo) params.set("to", nextTo)
    }
    if (nextGranularity !== "auto") params.set("granularity", nextGranularity)
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    startTransition(async () => {
      try {
        const payload = await apiFetch<DashboardPayload>(`${endpoint}?${params.toString()}`, {
          signal: controller.signal,
          cache: publicView ? "default" : "no-store",
        })
        if (activeRequest.current === controller) setDashboard(payload)
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
      }
    })
  }, [endpoint, publicView, workspaceId, apiFetch])

  useEffect(() => {
    query(defaultPreset)
    return () => activeRequest.current?.abort()
  }, [defaultPreset, query])

  function setPreset(value: DashboardQuery["preset"]) {
    setPresetState(value)
    if (value === "custom") return
    setFrom("")
    setTo("")
    query(value, "", "", activeGranularity)
  }

  function setGranularity(value: NonNullable<DashboardQuery["granularity"]>) {
    setGranularityState(value)
    query(preset, from, to, value)
  }

  function handleRangeChange(range: DateRange | undefined) {
    const nextFrom = formatCalendarSelection(range?.from)
    const nextTo = formatCalendarSelection(range?.to)
    setFrom(nextFrom)
    setTo(nextTo)
    setPresetState("custom")
    if (nextFrom && nextTo) query("custom", nextFrom, nextTo, activeGranularity)
  }

  return { dashboard, pending, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh: () => query(preset, from, to, activeGranularity) }
}
