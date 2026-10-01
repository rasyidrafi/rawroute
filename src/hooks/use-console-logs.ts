import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import type { LogScope, LogSnapshot } from "@/lib/logging/types"

export function useConsoleLogs(live: boolean, scope: LogScope) {
  const endpoint = scope.kind === "global" ? "/api/admin/logs/global" : "/api/admin/logs"
  const workspaceId = scope.kind === "workspace" ? scope.workspaceId : null
  const scopeKey = workspaceId ?? "global"
  const controllers = useMemo(() => ({ scopeKey, pending: new Set<AbortController>() }), [scopeKey])
  const pending = useRef<AbortController | null>(null)
  const [clearing, setClearing] = useState<string | null>(null)
  const [clearError, setClearError] = useState<{ scopeKey: string; message: string } | null>(null)
  const load = useCallback(async (method = "GET"): Promise<LogSnapshot> => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    controllers.pending.add(controller)
    try {
      const response = await fetch(endpoint, {
        method, credentials: "same-origin", cache: "no-store",
        headers: workspaceId ? { "x-rawroute-workspace-id": workspaceId } : {},
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      })
      if (!response.ok) throw new Error(response.status === 401 ? "Your session expired. Sign in again." : `Unable to ${method === "DELETE" ? "clear" : "load"} logs (HTTP ${response.status}).`)
      const data = await response.json() as LogSnapshot
      if (!Array.isArray(data.entries) || data.workspaceId !== workspaceId || data.scope !== (workspaceId ? "workspace" : "global")) throw new Error("Invalid log scope in response.")
      return data
    } finally { controllers.pending.delete(controller) }
  }, [endpoint, workspaceId, controllers])
  useEffect(() => () => { for (const controller of controllers.pending) controller.abort() }, [controllers])
  const { data, error, isLoading, isValidating, mutate } = useSWR<LogSnapshot>([endpoint, workspaceId], () => load(), {
    refreshInterval: live && clearing !== scopeKey ? 3000 : 0, refreshWhenHidden: false, revalidateOnFocus: false,
    dedupingInterval: 2000, keepPreviousData: false, shouldRetryOnError: false,
  })
  async function clear() {
    setClearing(scopeKey)
    setClearError(null)
    try {
      // SWR's mutation timestamp discards a GET that started before this deletion.
      await mutate(load("DELETE"), { revalidate: false })
      return true
    } catch (cause) {
      setClearError({ scopeKey, message: cause instanceof Error ? cause.message : "Unable to clear logs." })
      return false
    } finally { setClearing(null) }
  }
  return {
    snapshot: data?.workspaceId === workspaceId ? data : null,
    error: error instanceof Error ? error.message : null,
    clearError: clearError?.scopeKey === scopeKey ? clearError.message : null,
    busy: isValidating || clearing === scopeKey, isInitialLoading: isLoading,
    isRefreshing: isValidating, isClearing: clearing === scopeKey,
    refresh: () => mutate(), clear,
  }
}
