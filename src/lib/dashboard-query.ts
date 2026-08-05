import type { DashboardQuery } from "@/lib/types"

export function parseDashboardQuery(params: URLSearchParams): DashboardQuery {
  const preset = params.get("preset")
  const allowed = new Set<DashboardQuery["preset"]>(["today", "yesterday", "week", "month", "year", "all", "custom"])
  const granularity = params.get("granularity")
  return {
    preset: allowed.has(preset as DashboardQuery["preset"]) ? preset as DashboardQuery["preset"] : "today",
    from: params.get("from") || undefined,
    to: params.get("to") || undefined,
    ...(granularity && ["hourly", "daily", "weekly", "monthly"].includes(granularity) ? { granularity: granularity as DashboardQuery["granularity"] } : {}),
  }
}
