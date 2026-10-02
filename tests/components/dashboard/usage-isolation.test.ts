import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("admin usage does not seed a browser-selected workspace with Default data", () => {
  const page = readFileSync(new URL("../../../src/components/dashboard/route-views.tsx", import.meta.url), "utf8")
  const wrapper = readFileSync(new URL("../../../src/components/dashboard/ai/overview-usage-view.tsx", import.meta.url), "utf8")

  expect(page).not.toContain("getDashboardPayload")
  expect(page).toContain("<OverviewUsageView />")
  expect(wrapper).toContain("<OverviewUsageContent key={workspace.id} />")
})

test("public usage starts on the budget window", () => {
  const usageView = readFileSync(new URL("../../../src/hooks/use-usage-dashboard.ts", import.meta.url), "utf8")
  const overview = readFileSync(new URL("../../../src/components/dashboard/ai/usage-overview.tsx", import.meta.url), "utf8")

  expect(usageView).toContain("DEFAULT_DASHBOARD_QUERY.preset")
  expect(usageView).not.toContain("publicView ? \"today\" : DEFAULT_PRESET")
  expect(overview).not.toContain('PRESET_OPTIONS.filter((option) => option.value !== "budget")')
})
