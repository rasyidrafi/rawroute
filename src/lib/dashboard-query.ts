import type { DashboardQuery } from "@/lib/types"

export const DEFAULT_DASHBOARD_QUERY = { preset: "budget", granularity: "auto" } satisfies DashboardQuery

export function parseDashboardQuery(params: URLSearchParams): DashboardQuery {
  const preset = params.get("preset")
  const allowed = new Set<DashboardQuery["preset"]>(["today", "yesterday", "week", "lastWeek", "month", "lastMonth", "year", "all", "custom", "budget"])
  const granularity = params.get("granularity")
  return {
    ...DEFAULT_DASHBOARD_QUERY,
    preset: allowed.has(preset as DashboardQuery["preset"]) ? preset as DashboardQuery["preset"] : DEFAULT_DASHBOARD_QUERY.preset,
    ...(params.get("from") ? { from: params.get("from")! } : {}),
    ...(params.get("to") ? { to: params.get("to")! } : {}),
    ...(granularity && ["auto", "hourly", "daily", "weekly", "monthly"].includes(granularity) ? { granularity: granularity as DashboardQuery["granularity"] } : {}),
  }
}
