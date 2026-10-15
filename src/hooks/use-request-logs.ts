import { useCallback, useEffect, useMemo, useState } from "react"
import useSWR, { unstable_serialize, useSWRConfig } from "swr"
import { useDashboardApi } from "@/components/dashboard/api-context"
import type { RequestLogsPage } from "@/lib/request-logs"

type Snapshot = { page: RequestLogsPage; query: string }

function makeRange(days: string) {
  const now = Date.now()
  return { from: new Date(now - Number(days) * 86_400_000).toISOString(), to: new Date(now).toISOString() }
}

/** Live pages replace the latest 25 rows; pagination always uses the displayed range. */
export function useRequestLogs(days: string, status: string, model: string) {
  const { apiFetch, workspaceId } = useDashboardApi()
  const { cache } = useSWRConfig()
  const [live, setLive] = useState(true)
  const [history, setHistory] = useState<{ from: string; to: string; cursors: string[] } | null>(null)
  const query = JSON.stringify([workspaceId, days, status, model])
  const [previousQuery, setPreviousQuery] = useState(query)
  if (previousQuery !== query) { setPreviousQuery(query); setHistory(null) }
  const pending = useMemo(() => ({ query, history, controllers: new Set<AbortController>() }), [query, history])
  const cursor = history?.cursors.at(-1)
  const key = workspaceId ? ["request-logs", workspaceId, days, status, model, history?.from ?? "latest", history?.to ?? "latest", cursor ?? ""] : null
  const cacheKey = unstable_serialize(key)
  const load = useCallback(async () => {
    const controller = new AbortController()
    pending.controllers.add(controller)
    const range = history ?? makeRange(days)
    const params = new URLSearchParams({ from: range.from, to: range.to, status, model })
    if (cursor) params.set("cursor", cursor)
    try {
      const page = await apiFetch<RequestLogsPage>(`/api/admin/request-logs?${params}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      controller.signal.throwIfAborted()
      return { page, query }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause
      // SWR checks mutation timestamps only on success, not in its rejection path.
      // An intentional cancellation resolves with this key's cached snapshot so it
      // cannot publish AbortError or replace frozen rows, even if transport won a race.
      // Timeout/network failures do not abort this controller and still reject.
      const cached = cache.get(cacheKey) as { data?: Snapshot } | undefined
      return cached?.data
    } finally {
      pending.controllers.delete(controller)
    }
  }, [apiFetch, cache, cacheKey, cursor, days, history, model, pending, query, status])
  const { data: snapshot, error, isLoading, isValidating, mutate } = useSWR(key, load, {
    revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false,
    keepPreviousData: true, dedupingInterval: 0,
  })
  const data = snapshot?.query === query ? snapshot.page : undefined

  // Schedule after completion, not on a fixed timer: slow requests never queue catch-up work.
  // Unlike SWR's built-in interval, this also retries a failed snapshot without clearing rows.
  useEffect(() => {
    if (!live || !workspaceId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const available = () => document.visibilityState !== "hidden" && navigator.onLine
    async function update() {
      if (disposed || !available() || pending.controllers.size) { schedule(); return }
      try { await mutate() } catch { /* SWR exposes the error beside the retained snapshot. */ }
      finally { schedule() }
    }
    function schedule() {
      clearTimeout(timer)
      if (!disposed && available()) timer = setTimeout(() => void update(), 3000)
    }
    function availabilityChanged() {
      clearTimeout(timer)
      if (available()) void update()
      else for (const controller of pending.controllers) controller.abort()
    }
    schedule()
    document.addEventListener("visibilitychange", availabilityChanged)
    window.addEventListener("online", availabilityChanged)
    window.addEventListener("offline", availabilityChanged)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", availabilityChanged)
      window.removeEventListener("online", availabilityChanged)
      window.removeEventListener("offline", availabilityChanged)
    }
  }, [live, mutate, pending, workspaceId])

  useEffect(() => () => { for (const controller of pending.controllers) controller.abort() }, [pending])

  function freeze() {
    for (const controller of pending.controllers) controller.abort()
    // Mutation invalidates an already-started GET, including one resolving during pause.
    void mutate(snapshot, { revalidate: false })
    setLive(false)
  }
  function toggleLive(value: boolean) {
    if (!value) { freeze(); return }
    setHistory(null)
    setLive(true)
    if (!history) void mutate()
  }
  function refresh() {
    for (const controller of pending.controllers) controller.abort()
    if (history) setHistory(null)
    else void mutate()
  }
  function older() {
    if (!data?.nextCursor) return
    freeze()
    setHistory({ from: data.from, to: data.to, cursors: [...(history?.cursors ?? []), data.nextCursor] })
  }
  function newer() {
    if (history) setHistory({ ...history, cursors: history.cursors.slice(0, -1) })
  }
  return { data, error, isLoading, isValidating, live, toggleLive, refresh, older, newer, hasNewer: !!history?.cursors.length }
}
