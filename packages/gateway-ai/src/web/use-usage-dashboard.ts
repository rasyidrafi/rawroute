import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import type { DateRange } from "react-day-picker"
import type { DashboardPayload, DashboardQuery } from "../contracts/domain"
import { DEFAULT_DASHBOARD_QUERY } from "../contracts/dashboard-defaults"
import { calendarDateFromInstant } from "@rawroute/observability/contracts/timezone"
import { useDashboardApi } from "@rawroute/platform/web/api-context"
import { DEFAULT_GRANULARITY, formatCalendarSelection, getGranularityOptions, resolveSelectedRange } from "./components/usage-utils"

export function useUsageDashboard({ publicView = false, workspaceId, keyId, refreshIntervalMs }: { publicView?: boolean; workspaceId?: string; keyId?: string; refreshIntervalMs?: number } = {}) {
  const { apiFetch } = useDashboardApi()
  const endpoint = publicView ? "/api/public/dashboard" : "/api/admin/usage"
  const defaultPreset: DashboardQuery["preset"] = DEFAULT_DASHBOARD_QUERY.preset
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loadedPreset, setLoadedPreset] = useState<DashboardQuery["preset"] | null>(null)
  const [lastBudgetPayload, setLastBudgetPayload] = useState<DashboardPayload | null>(null)
  const [preset, setPresetState] = useState<DashboardQuery["preset"]>(defaultPreset)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [granularity, setGranularityState] = useState<NonNullable<DashboardQuery["granularity"]>>(DEFAULT_GRANULARITY)
  const [, startTransition] = useTransition()
  const [userRequest, setUserRequest] = useState<AbortController | null>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const selectedRange = useMemo<DateRange | undefined>(() => {
    if (preset === "budget" && dashboard) return { from: calendarDateFromInstant(dashboard.range.from), to: calendarDateFromInstant(dashboard.range.to) }
    return resolveSelectedRange(from, to)
  }, [dashboard, from, preset, to])
  const activeGranularity = getGranularityOptions(preset).some((option) => option.value === granularity) ? granularity : DEFAULT_GRANULARITY

  const buildParams = useCallback((nextPreset: DashboardQuery["preset"], nextFrom: string, nextTo: string, nextGranularity: NonNullable<DashboardQuery["granularity"]>) => {
    const effectiveGranularity = getGranularityOptions(nextPreset).some((option) => option.value === nextGranularity) ? nextGranularity : DEFAULT_GRANULARITY
    const params = new URLSearchParams({ preset: nextPreset })
    if (keyId && !publicView) params.set("key", keyId)
    if (publicView && workspaceId && workspaceId !== "default") params.set("workspace", workspaceId)
    if (nextPreset === "custom") {
      params.set("from", nextFrom)
      params.set("to", nextTo)
    }
    if (effectiveGranularity !== "auto") params.set("granularity", effectiveGranularity)
    return params
  }, [keyId, publicView, workspaceId])

  // Updates inside an async transition only flush when it settles, so the
  // user-visible request mark is set by query() synchronously, not in here.
  const runFetch = useCallback((params: URLSearchParams, nextPreset: DashboardQuery["preset"]) => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    startTransition(async () => {
      try {
        const payload = await apiFetch<DashboardPayload>(`${endpoint}?${params.toString()}`, {
          signal: controller.signal,
          cache: publicView ? "default" : "no-store",
        })
        if (activeRequest.current === controller) {
          setDashboard(payload)
          setError(null)
          setLoadedPreset(nextPreset)
          if (nextPreset === "budget") setLastBudgetPayload(payload)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        if (activeRequest.current === controller) setError(error)
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null
        // A superseding user request marks itself synchronously, so only the
        // tracked controller's own settlement clears the flag.
        setUserRequest(current => current === controller ? null : current)
      }
    })
    return controller
  }, [endpoint, publicView, apiFetch])

  const query = useCallback((nextPreset: DashboardQuery["preset"], nextFrom = "", nextTo = "", nextGranularity = DEFAULT_GRANULARITY, background = false) => {
    if (nextPreset === "custom" && (!nextFrom || !nextTo)) return
    const controller = runFetch(buildParams(nextPreset, nextFrom, nextTo, nextGranularity), nextPreset)
    // Only user-initiated fetches surface loading UI; interval refreshes stay silent.
    if (!background) setUserRequest(controller)
  }, [runFetch, buildParams])

  useEffect(() => {
    // Initial load surfaces skeletons through absent data, not the refreshing flag.
    runFetch(buildParams(defaultPreset, "", "", DEFAULT_GRANULARITY), defaultPreset)
    return () => activeRequest.current?.abort()
  }, [defaultPreset, runFetch, buildParams])

  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    refreshRef.current = () => query(preset, from, to, activeGranularity, true)
  }, [query, preset, from, to, activeGranularity])
  useEffect(() => {
    if (!refreshIntervalMs) return
    // Skip ticks while any fetch is active: a poll must never abort a user
    // request (stranding its overlay) or queue catch-up work behind slow responses.
    const id = setInterval(() => { if (!activeRequest.current) refreshRef.current() }, refreshIntervalMs)
    return () => clearInterval(id)
  }, [refreshIntervalMs])

  function setPreset(value: DashboardQuery["preset"]) {
    setPresetState(value)
    if (value === "custom") return
    setFrom("")
    setTo("")
    const nextGranularity = getGranularityOptions(value).some((option) => option.value === granularity) ? granularity : DEFAULT_GRANULARITY
    setGranularityState(nextGranularity)
    query(value, "", "", nextGranularity)
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

  return { dashboard, error, loadedPreset, lastBudgetPayload, refreshing: userRequest !== null, preset, setPreset, activeGranularity, setGranularity, selectedRange, handleRangeChange, refresh: () => query(preset, from, to, activeGranularity) }
}
