import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

test("admin usage does not seed a browser-selected workspace with Default data", () => {
  const page = readFileSync(new URL("../../app/dashboard/usage/page.tsx", import.meta.url), "utf8")
  const wrapper = readFileSync(new URL("./admin-usage-view.tsx", import.meta.url), "utf8")

  expect(page).not.toContain("getDashboardPayload")
  expect(page).toContain("<AdminUsageView />")
  expect(wrapper).toContain("<UsageView key={workspace.id} workspaceId={workspace.id} />")
})

test("public usage starts on the budget window", () => {
  const page = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8")
  const usageView = readFileSync(new URL("./usage-view.tsx", import.meta.url), "utf8")
  const overview = readFileSync(new URL("./usage-overview.tsx", import.meta.url), "utf8")

  expect(page).toContain("const initialQuery = DEFAULT_DASHBOARD_QUERY")
  expect(usageView).not.toContain("publicView ? \"today\" : DEFAULT_PRESET")
  expect(overview).not.toContain('PRESET_OPTIONS.filter((option) => option.value !== "budget")')
})

test("dashboard routes require a session and login redirects signed-in users", () => {
  const layout = readFileSync(new URL("../../app/dashboard/layout.tsx", import.meta.url), "utf8")
  const login = readFileSync(new URL("../../app/login/page.tsx", import.meta.url), "utf8")

  expect(layout).toContain('if (!(await isAuthenticated())) redirect("/login")')
  expect(login).toContain('if (await isAuthenticated()) redirect("/dashboard")')
})
