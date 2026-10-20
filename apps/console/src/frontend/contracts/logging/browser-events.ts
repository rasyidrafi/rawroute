import { dashboardPages, isDashboardPage, type DashboardPage } from "../dashboard/routes"
import type { LogScope } from "@rawroute/observability/contracts/types"

import { type BrowserEvent } from "@rawroute/observability/contracts/browser-events"
export { browserEvents, type BrowserEvent } from "@rawroute/observability/contracts/browser-events"

export function browserEventScope(event: BrowserEvent, page: unknown): LogScope["kind"] | undefined {
  if ((event === "dashboard.error" || event === "dashboard.rejection") && page === undefined) return "global"
  if (!isDashboardPage(page)) return undefined
  if (event.startsWith("logs.") && page !== "logs" && page !== "systemLogs") return undefined
  return dashboardPages[page].scope
}

export type BrowserReport = { event: BrowserEvent; page?: DashboardPage }
