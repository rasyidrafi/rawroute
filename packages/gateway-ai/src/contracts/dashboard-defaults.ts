import type { DashboardQuery } from "./domain"

export const DEFAULT_DASHBOARD_QUERY = { preset: "budget", granularity: "auto" } satisfies DashboardQuery
