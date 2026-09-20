import { expect, test } from "vitest"

import { dashboardAppForPathname, dashboardApps, isDashboardNavigationItemActive } from "@/components/dashboard/dashboard-apps"

test("selects the Tool Gateway app from its URL and keeps AI Gateway routes compatible", () => {
  expect(dashboardAppForPathname("/dashboard").id).toBe("ai-gateway")
  expect(dashboardAppForPathname("/dashboard/providers/codex").id).toBe("ai-gateway")
  expect(dashboardAppForPathname("/dashboard/tool-gateway/tools").id).toBe("tool-gateway")
})

test("matches contextual navigation without treating an app overview as every child page", () => {
  const toolGateway = dashboardAppForPathname("/dashboard/tool-gateway")
  const overview = toolGateway.navigation[0].items[0]
  const tools = toolGateway.navigation[0].items[1]

  expect(isDashboardNavigationItemActive("/dashboard/tool-gateway/tools", overview)).toBe(false)
  expect(isDashboardNavigationItemActive("/dashboard/tool-gateway/tools", tools)).toBe(true)
})

test("uses exact app switcher labels without an Executor suffix", () => {
  const labels = dashboardApps.map((app) => app.title)

  expect(labels).toEqual(["AI Gateway", "Tool Gateway"])
  expect(labels.join(" ")).not.toContain("(Executor)")
})
