import { dashboardPages, dashboardPageForPath } from "@/lib/dashboard/routes"
import { expect, test } from "bun:test"

import { dashboardApps, isDashboardNavigationItemActive } from "@/components/dashboard/dashboard-apps"

test("resolves the application from canonical route metadata", () => {
  expect(dashboardPages[dashboardPageForPath("/dashboard/ai/endpoint")!].app).toBe("ai-gateway")
  expect(dashboardPages[dashboardPageForPath("/dashboard/ai/codex-providers")!].app).toBe("ai-gateway")
  expect(dashboardPages[dashboardPageForPath("/dashboard/tools/catalog")!].app).toBe("tool-gateway")
})

test("matches contextual navigation without treating an app overview as every child page", () => {
  const toolGateway = dashboardApps.find(app => app.id === "tool-gateway")!
  const overview = toolGateway.navigation[0].items[0]
  const tools = toolGateway.navigation[0].items[1]

  expect(isDashboardNavigationItemActive("/dashboard/tools/catalog", overview)).toBe(false)
  expect(isDashboardNavigationItemActive("/dashboard/tools/catalog", tools)).toBe(true)
})

test("uses exact app switcher labels without an Executor suffix", () => {
  const labels = dashboardApps.map((app) => app.title)

  expect(labels).toEqual(["AI Gateway", "Tool Gateway"])
  expect(labels.join(" ")).not.toContain("(Executor)")
})

test("Overview navigation places Request Logs after Usage and selects only the current page", () => {
  const group = dashboardApps.find(app => app.id === "ai-gateway")!.navigation[0]!
  expect(group.label).toBe("Overview")
  expect(group.items.map(item => item.title)).toEqual(["Overview", "Usage", "Request Logs"])
  for (const current of group.items) {
    expect(group.items.filter(item => isDashboardNavigationItemActive(current.href, item))).toEqual([current])
  }
  expect(dashboardPages.requestLogs.scope).toBe("workspace")
})
