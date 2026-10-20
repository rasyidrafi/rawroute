import { pagePathsFor, type DashboardPageMeta } from "./dashboard"

export const observabilityPages = {
  logs: { path: "/dashboard/logs", skeleton: "console-log", title: "Console Log", scope: "workspace", owner: "observability", app: "shared" },
  systemLogs: { path: "/dashboard/system-logs", skeleton: "system-logs", title: "System Logs", scope: "global", owner: "observability", app: "shared" },
} as const satisfies Record<string, DashboardPageMeta>

export const observabilityPagePaths = pagePathsFor(observabilityPages)
