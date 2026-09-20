import { expect, test } from "vitest"

import { dashboardAppForPathname, isDashboardNavigationItemActive } from "@/components/dashboard/dashboard-apps"

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
