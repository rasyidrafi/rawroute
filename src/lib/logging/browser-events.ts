import { dashboardPages, isDashboardPage, type DashboardPage } from "@/lib/dashboard/routes"
import type { LogScope } from "./types"

export const browserEvents = {
  "dashboard.navigation": "Dashboard page opened",
  "dashboard.copy": "Clipboard copy completed",
  "dashboard.copy-failed": "Clipboard copy failed",
  "dashboard.error": "Dashboard runtime error (details omitted)",
  "dashboard.rejection": "Dashboard unhandled rejection (details omitted)",
  "logs.copied": "Log entries copied",
  "logs.paused": "Live log updates paused",
  "logs.resumed": "Live log updates resumed",
} as const
export type BrowserEvent = keyof typeof browserEvents

export function browserEventScope(event: BrowserEvent, page: unknown): LogScope["kind"] | undefined {
  if ((event === "dashboard.error" || event === "dashboard.rejection") && page === undefined) return "global"
  if (!isDashboardPage(page)) return undefined
  if (event.startsWith("logs.") && page !== "logs" && page !== "systemLogs") return undefined
  return dashboardPages[page].scope
}

export type BrowserReport = { event: BrowserEvent; page?: DashboardPage }
